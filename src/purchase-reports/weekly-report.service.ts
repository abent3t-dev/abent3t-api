import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildWorkbook,
  excelSheet,
  NO_DISPONIBLE,
} from '../common/utils/excel-export.util';
import type { ExcelColumn } from '../common/utils/excel-export.util';
import { SapRecordsService } from '../sap-records/sap-records.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { buyerText, maximoBuyer } from '../common/utils/buyer.util';
import { maximoStatusWithCode } from '../common/utils/maximo-status.util';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import {
  andMaximoPrInWindow,
  loadMaximoPrFolioWindow,
  MAXIMO_PRS_WITH_PO,
} from '../common/sql/erp-views.sql';
import {
  SAP_PO_EXPORT_COLUMNS,
  SAP_PR_EXPORT_COLUMNS,
} from '../sap-records/sap-records.export';
import type {
  SapApprovalLineView,
  SapPurchaseOrderRow,
  SapPurchaseRequestRow,
} from '../sap-records/sap-records.types';
import { ReportPeriodDto } from './dto/report-period.dto';
import {
  CURRENT_MAXIMO_CONTRACTS,
  CURRENT_MAXIMO_POS,
  PurchaseReportsService,
} from './purchase-reports.service';
import { AvanceSemanalService } from './avance-semanal/avance-semanal.service';
import {
  type AvancePage,
  buildAvancePage,
  lastCompleteWeek,
} from './avance-semanal/avance-semanal.engine';

/**
 * Reporte semanal de Compras (Ingrid, 2026-09-23): un Excel con el resumen
 * del periodo contra el periodo anterior de la misma duración y el detalle
 * de lo que se movió (OC y solicitudes de SAP y Maximo creadas en el
 * periodo, autorizaciones pendientes y quién las tiene).
 *
 * Solo lectura: reutiliza el resumen de Reportes (una sola definición por
 * métrica) y el listado de SAP (saldo y solicitante incluidos). Montos por
 * moneda, nunca sumados entre monedas; sin dato = "Sin datos", nunca 0.
 *
 * 2026-09-28: G1 proveedor efectivo en las OC de Maximo; G2 días de gestión
 * RQ → OC por sistema (promedio y mediana); G3 pendientes = RQ sin OC; las
 * PR de Maximo del periodo se ubican por folio; G7 etiquetas de estatus.
 *
 * 2026-09-29 (H1): hoja "Avance semanal" con los KPIs del PDF del reporte de
 * avance semanal (mismo motor), de la última semana completa del periodo.
 */

const DAY_MS = 86_400_000;

/** Columnas del detalle SAP que van al reporte (mismas etiquetas que el export). */
const SAP_PO_HEADERS = [
  'Número',
  'Proveedor',
  'Estatus',
  'Monto',
  'Saldo disponible',
  'Moneda',
  'Solicitante',
  'Comprador',
  'Origen',
  'Capturó (SAP)',
  'F. Documento',
  'F. Entrega',
];
const SAP_PR_HEADERS = [
  'Número',
  'Solicitante',
  'Estatus',
  'Monto (líneas, sin IVA)',
  'Moneda',
  'F. Documento',
  'F. Requerida',
];

// G7: etiqueta provisional + código ("En aprobación · nivel 1 aprobado (APPR1)")
const maximoStatus = (status: string | null) => maximoStatusWithCode(status);

interface SummaryRow {
  indicador: string;
  actual: number | string | null;
  anterior: number | string | null;
  nota?: string;
  money?: boolean;
}

interface AvanceRow {
  indicador: string;
  valor: number | string | null;
  nota?: string;
  money?: boolean;
}

interface MaximoPoRow {
  ponum: string;
  description: string | null;
  status: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  total_cost: unknown;
  currency: string | null;
  requested_by: string | null;
  purchase_agent: string | null;
  purchase_agent_name: string | null;
  created_by: string | null;
  department: string | null;
  created_at_source: Date | null;
  approved_at: Date | null;
  approved_by: string | null;
}

interface MaximoPrRow {
  prnum: string | null;
  contractnum: string | null;
  status: string | null;
  /** G3: la PR ya tiene OC vigente (o contrato). */
  con_oc: boolean;
  vendor_name: string | null;
  contract_value: unknown;
  currency: string | null;
  requested_by: string | null;
  created_at_source: Date | null;
  approved_at: Date | null;
}

interface PendingApprovalRow {
  object_type: string | null;
  doc_num: number | null;
  card_name: string | null;
  doc_total: unknown;
  currency: string | null;
  requester_name: string | null;
  originator_name: string | null;
  current_stage: number | null;
  current_stage_name: string | null;
  creation_date: Date | null;
  /** Días naturales desde la creación de la solicitud de autorización. */
  dias: number | null;
  approvers: unknown;
}

interface OpenBalanceRow {
  currency: string | null;
  saldo: unknown;
  count: number;
}

const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** 'YYYY-MM-DD' → 'dd/mm/yyyy' para encabezados y notas. */
function dmy(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

@Injectable()
export class WeeklyReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: PurchaseReportsService,
    private readonly sap: SapRecordsService,
    private readonly aliases: ErpAliasesService,
    private readonly vendors: MaximoVendorXrefService,
    private readonly avance: AvanceSemanalService,
  ) {}

  /** Periodo anterior: mismos días, justo antes de `from`. */
  previousPeriod(from: string, to: string): { from: string; to: string } {
    const days =
      Math.round(
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
          DAY_MS,
      ) + 1;
    const prevTo = shiftDays(from, -1);
    return { from: shiftDays(prevTo, -(days - 1)), to: prevTo };
  }

  async buildWorkbook(
    dto: ReportPeriodDto,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const period = this.reports.resolvePeriod(dto);
    const from = period.from.toISOString().slice(0, 10);
    const to = period.to.toISOString().slice(0, 10);
    const prev = this.previousPeriod(from, to);
    const periodTo = period.to;
    // H1: datos del avance semanal (se cargan en paralelo con lo demás)
    const avanceData = this.avance.loadData();
    // G3: las PR de Maximo del periodo se ubican por folio (sin fecha propia)
    const prWindow = await loadMaximoPrFolioWindow(
      this.prisma,
      period.from,
      new Date(periodTo.getTime() + 1),
    );

    const [
      actual,
      anterior,
      tiempos,
      sapPos,
      sapPrs,
      maximoPos,
      maximoPrs,
      pendingApprovals,
      openBalance,
    ] = await Promise.all([
      this.reports.getResumen({ from, to }),
      this.reports.getResumen(prev),
      this.reports.getTiemposAprobacion(),
      this.sap.listAllForExport('purchase_orders', { from, to }),
      this.sap.listAllForExport('purchase_requests', { from, to }),
      this.prisma.$queryRaw<MaximoPoRow[]>(Prisma.sql`
        SELECT ponum, description, status, vendor_id, vendor_name, total_cost, currency,
               requested_by, purchase_agent, purchase_agent_name, created_by,
               department, created_at_source, approved_at, approved_by
        FROM (${CURRENT_MAXIMO_POS}) current
        WHERE created_at_source BETWEEN ${period.from} AND ${periodTo}
        ORDER BY created_at_source DESC`),
      this.prisma.$queryRaw<MaximoPrRow[]>(Prisma.sql`
        SELECT prnum, contractnum, status, vendor_name, contract_value, currency,
               requested_by, created_at_source, approved_at,
               (has_contract OR prnum IN (${MAXIMO_PRS_WITH_PO})) AS con_oc
        FROM (${CURRENT_MAXIMO_CONTRACTS}) current
        WHERE prnum IS NOT NULL ${andMaximoPrInWindow('current', prWindow)}
        ORDER BY prnum DESC`),
      this.prisma.$queryRaw<PendingApprovalRow[]>(Prisma.sql`
        SELECT object_type, doc_num, card_name, doc_total, currency,
               requester_name, originator_name, current_stage,
               current_stage_name, creation_date, approvers,
               (current_date - creation_date::date)::int AS dias
        FROM sap_approval_requests
        WHERE status = 'arsPending'
        ORDER BY creation_date ASC NULLS LAST`),
      this.prisma.$queryRaw<OpenBalanceRow[]>(Prisma.sql`
        SELECT currency, sum(open_total) AS saldo, count(*)::int AS count
        FROM sap_purchase_orders
        WHERE document_status = 'bost_Open' AND cancelled IS DISTINCT FROM true
          AND open_total IS NOT NULL
        GROUP BY currency ORDER BY count DESC`),
    ]);

    // D6/E4: usuarios de Maximo con su nombre (alias de Compras)
    const names = await this.aliases.resolveMany('maximo', [
      ...maximoPos.flatMap((r) => [
        r.requested_by,
        r.approved_by,
        r.purchase_agent,
        r.created_by,
      ]),
      ...maximoPrs.map((r) => r.requested_by),
    ]);
    const person = (code: string | null) =>
      code ? (names.get(code) ?? code) : null;
    // G1: proveedor efectivo de las OC de Maximo
    const maximoPoRows = await this.vendors.resolve(maximoPos);

    const summary = this.summaryRows(actual, anterior, tiempos, openBalance);
    // H1: última semana completa hasta el fin del periodo
    const avancePage = buildAvancePage(
      await avanceData,
      lastCompleteWeek(new Date(periodTo.getTime() + 1)),
      'todas',
      new Date(),
    );
    const periodLabel = `${dmy(from)} al ${dmy(to)}`;
    const prevLabel = `${dmy(prev.from)} al ${dmy(prev.to)}`;
    const summaryColumns: ExcelColumn<SummaryRow>[] = [
      { header: 'Indicador', value: (r) => r.indicador, width: 46 },
      {
        header: `Periodo ${periodLabel}`,
        value: (r) => r.actual,
        width: 24,
        cellFormat: (r) => (r.money ? '#,##0.00' : undefined),
      },
      {
        header: `Anterior ${prevLabel}`,
        value: (r) => r.anterior,
        width: 24,
        cellFormat: (r) => (r.money ? '#,##0.00' : undefined),
      },
      { header: 'Nota', value: (r) => r.nota, width: 60 },
    ];

    const pick = <T>(columns: ExcelColumn<T>[], headers: string[]) =>
      headers
        .map((h) => columns.find((c) => c.header === h))
        .filter((c): c is ExcelColumn<T> => c !== undefined);

    const approvalRows = pendingApprovals.map((r) => this.approvalRow(r));
    const avgBy = new Map(
      tiempos.sap.por_aprobador.map((a) => [a.aprobador, a.promedio_dias]),
    );

    const buffer = await buildWorkbook(
      [
        excelSheet('Resumen', summaryColumns, summary),
        excelSheet<AvanceRow>(
          'Avance semanal',
          [
            { header: 'Indicador', value: (r) => r.indicador, width: 46 },
            {
              header: 'Valor',
              value: (r) => r.valor,
              width: 30,
              cellFormat: (r) => (r.money ? '#,##0.00' : undefined),
            },
            { header: 'Nota', value: (r) => r.nota, width: 70 },
          ],
          this.avanceRows(avancePage),
        ),
        excelSheet(
          'OC SAP',
          pick(SAP_PO_EXPORT_COLUMNS, SAP_PO_HEADERS),
          sapPos.rows as SapPurchaseOrderRow[],
        ),
        excelSheet(
          'Solicitudes SAP',
          pick(SAP_PR_EXPORT_COLUMNS, SAP_PR_HEADERS),
          sapPrs.rows as SapPurchaseRequestRow[],
        ),
        excelSheet<(typeof maximoPoRows)[number]>(
          'OC Maximo',
          [
            { header: 'PONUM', value: (r) => r.ponum, width: 14 },
            { header: 'Descripción', value: (r) => r.description, width: 44 },
            {
              header: 'Estatus',
              value: (r) => maximoStatus(r.status),
              width: 22,
            },
            // G1: según SAP si la OC migró o por cruce; si no, Maximo
            { header: 'Proveedor', value: (r) => r.supplier.name, width: 36 },
            {
              header: 'Código proveedor',
              value: (r) => r.supplier.code,
              width: 14,
            },
            {
              header: 'Proveedor en Maximo',
              value: (r) => (r.supplier.differs ? r.vendor_name : null),
              width: 32,
            },
            {
              header: 'Monto',
              value: (r) => num(r.total_cost),
              kind: 'money',
              width: 16,
            },
            { header: 'Moneda', value: (r) => r.currency, width: 10 },
            {
              header: 'Solicitado por',
              value: (r) => person(r.requested_by),
              width: 22,
            },
            // E4: comprador (PURCHASEAGENT) con su nombre
            {
              header: 'Comprador',
              value: (r) => buyerText(maximoBuyer(r, names)),
              width: 26,
            },
            { header: 'Departamento', value: (r) => r.department, width: 18 },
            {
              header: 'F. Orden',
              value: (r) => r.created_at_source,
              kind: 'date',
              width: 14,
            },
            {
              header: 'F. Aprobación',
              value: (r) => r.approved_at,
              kind: 'date',
              width: 14,
            },
            {
              header: 'Aprobó',
              value: (r) => person(r.approved_by),
              width: 22,
            },
          ],
          maximoPoRows,
        ),
        excelSheet<MaximoPrRow>(
          'Solicitudes Maximo',
          [
            { header: 'PRNUM', value: (r) => r.prnum, width: 14 },
            { header: 'Contrato', value: (r) => r.contractnum, width: 14 },
            {
              header: 'Estatus',
              value: (r) => maximoStatus(r.status),
              width: 22,
            },
            {
              header: 'Con OC',
              value: (r) => (r.con_oc ? 'Sí' : 'No (pendiente de gestionar)'),
              width: 24,
            },
            { header: 'Proveedor', value: (r) => r.vendor_name, width: 36 },
            {
              header: 'Valor',
              value: (r) => num(r.contract_value),
              kind: 'money',
              width: 16,
            },
            { header: 'Moneda', value: (r) => r.currency, width: 10 },
            {
              header: 'Solicitado por',
              value: (r) => r.requested_by,
              width: 18,
            },
            {
              header: 'F. Solicitud',
              value: (r) => r.created_at_source,
              kind: 'date',
              width: 14,
            },
            {
              header: 'F. Aprobación',
              value: (r) => r.approved_at,
              kind: 'date',
              width: 14,
            },
          ],
          maximoPrs,
        ),
        excelSheet<ReturnType<WeeklyReportService['approvalRow']>>(
          'Autorizaciones SAP',
          [
            { header: 'Documento', value: (r) => r.tipo, width: 12 },
            {
              header: 'Número',
              value: (r) => r.numero,
              kind: 'int',
              width: 10,
            },
            { header: 'Proveedor', value: (r) => r.proveedor, width: 36 },
            {
              header: 'Monto',
              value: (r) => r.monto,
              kind: 'money',
              width: 16,
            },
            { header: 'Moneda', value: (r) => r.moneda, width: 10 },
            { header: 'Solicitante', value: (r) => r.solicitante, width: 28 },
            { header: 'Etapa', value: (r) => r.etapa, width: 24 },
            { header: 'Pendiente de', value: (r) => r.aprobadores, width: 36 },
            {
              header: 'Creada',
              value: (r) => r.creada,
              kind: 'date',
              width: 14,
            },
            {
              header: 'Días esperando',
              value: (r) => r.dias,
              kind: 'int',
              width: 14,
            },
          ],
          approvalRows,
        ),
        excelSheet(
          'Pendientes por aprobador',
          [
            { header: 'Aprobador', value: (r) => r.aprobador, width: 32 },
            {
              header: 'Pendientes',
              value: (r) => r.pendientes,
              kind: 'int',
              width: 12,
            },
            {
              header: 'La más antigua (días)',
              value: (r) => r.dias_esperando_max,
              kind: 'int',
              width: 20,
            },
            {
              header: 'Su promedio histórico (días)',
              value: (r) => avgBy.get(r.aprobador) ?? NO_DISPONIBLE,
              width: 26,
            },
            {
              header: 'Estado',
              value: (r) => {
                const avg = avgBy.get(r.aprobador);
                if (avg === undefined || r.dias_esperando_max === null) {
                  return 'Sin historial';
                }
                return r.dias_esperando_max > avg ? 'Retrasado' : 'En tiempo';
              },
              width: 14,
            },
          ],
          tiempos.sap.pendientes_por_aprobador,
        ),
      ],
      [
        `Reporte de Compras del ${periodLabel}, comparado contra el periodo anterior de la misma duración (${prevLabel}). Generado el ${dmy(new Date().toISOString().slice(0, 10))}.`,
        'Fuentes: SAP Business One, Maximo (vista vigente: última revisión de cada documento) y la captura propia de ABENT.',
        'Montos por moneda: nunca se suman MXN con USD o EUR. OC de SAP con IVA en la moneda del documento; solicitudes de SAP sin IVA (suma de sus líneas).',
        'Saldo disponible: parte de la OC de SAP aún no recibida ni facturada (cantidad pendiente de cada línea), con IVA.',
        'Solicitante de una OC de SAP: el de la solicitud de pedido de SAP de la que nació; si la OC viene de Maximo (columna "Origen"), el solicitante de Maximo; si no hay, queda vacío.',
        'Comprador: en Maximo es el comprador de la OC (PURCHASEAGENT); si no lo trae (casi todas), "Capturó: …" es quien creó la OC en Maximo. SAP no tiene comprador capturado en ninguna OC: las OC de SAP creadas desde Maximo muestran lo de Maximo y las demás "Capturó: …" (el usuario de SAP que la capturó).',
        'Los indicadores marcados "al día de hoy" son una foto al generar el archivo, no del periodo; por eso no tienen columna anterior.',
        'Estado por aprobador: "Retrasado" cuando su pendiente más antigua ya rebasó su promedio histórico de autorización. Ambos cuentan desde que el documento le llegó a ese aprobador (la aprobación de la etapa anterior o la creación); "Días esperando" de la hoja de autorizaciones cuenta desde la creación.',
        `Avance semanal (${avancePage.semana.etiqueta}): los mismos KPIs que el PDF "Reporte de avance semanal" de Reportes (Maximo + SAP, por cohorte del año).`,
        ...avancePage.notas.map((nota) => `Avance semanal: ${nota}`),
        ...(sapPos.truncated || sapPrs.truncated
          ? ['El detalle de SAP excede el tope de filas; acota el periodo.']
          : []),
      ],
    );
    return { buffer, filename: `reporte_compras_${from}_${to}.xlsx` };
  }

  private summaryRows(
    actual: Awaited<ReturnType<PurchaseReportsService['getResumen']>>,
    anterior: Awaited<ReturnType<PurchaseReportsService['getResumen']>>,
    tiempos: Awaited<
      ReturnType<PurchaseReportsService['getTiemposAprobacion']>
    >,
    openBalance: OpenBalanceRow[],
  ): SummaryRow[] {
    const a = actual.todas_las_fuentes;
    const b = anterior.todas_las_fuentes;
    const days = (v: number | null) => (v === null ? 'Sin datos' : v);
    const rows: SummaryRow[] = [
      {
        indicador: 'Solicitudes creadas',
        actual: a.solicitudes.creadas,
        anterior: b.solicitudes.creadas,
        nota: 'SAP + Maximo + ABENT',
      },
      {
        indicador: '   SAP',
        actual: a.solicitudes.por_fuente.sap.creadas,
        anterior: b.solicitudes.por_fuente.sap.creadas,
      },
      {
        indicador: '   Maximo',
        actual: a.solicitudes.por_fuente.maximo.creadas,
        anterior: b.solicitudes.por_fuente.maximo.creadas,
      },
      {
        indicador: '   ABENT',
        actual: a.solicitudes.por_fuente.abent.creadas,
        anterior: b.solicitudes.por_fuente.abent.creadas,
      },
      {
        indicador: 'Órdenes de compra creadas',
        actual: a.ordenes.total,
        anterior: b.ordenes.total,
        nota: 'No canceladas',
      },
      {
        indicador: '   SAP',
        actual: a.ordenes.por_fuente.sap,
        anterior: b.ordenes.por_fuente.sap,
      },
      {
        indicador: '   Maximo',
        actual: a.ordenes.por_fuente.maximo,
        anterior: b.ordenes.por_fuente.maximo,
      },
      {
        indicador: '   ABENT',
        actual: a.ordenes.por_fuente.abent,
        anterior: b.ordenes.por_fuente.abent,
      },
    ];
    const currencies = [
      ...new Set(
        [...a.ordenes.monto_por_moneda, ...b.ordenes.monto_por_moneda].map(
          (m) => m.currency,
        ),
      ),
    ];
    for (const currency of currencies) {
      const amount = (list: typeof a.ordenes.monto_por_moneda) =>
        list.find((m) => m.currency === currency)?.total ?? 0;
      rows.push({
        indicador: `Monto de OC creadas (${currency})`,
        actual: amount(a.ordenes.monto_por_moneda),
        anterior: amount(b.ordenes.monto_por_moneda),
        money: true,
      });
    }
    rows.push(
      // G2: de que se crea la RQ a que se crea la OC (OC del periodo)
      {
        indicador: 'Días de gestión SAP (promedio)',
        actual: days(a.dias_gestion.sap.promedio_dias),
        anterior: days(b.dias_gestion.sap.promedio_dias),
        nota: `De la solicitud de pedido a la OC · ${a.dias_gestion.sap.total} OC del periodo con solicitud`,
      },
      {
        indicador: 'Días de gestión SAP (mediana)',
        actual: days(a.dias_gestion.sap.mediana_dias),
        anterior: days(b.dias_gestion.sap.mediana_dias),
        nota: 'La mitad de las OC se gestionó en menos días que esto',
      },
      {
        indicador: 'Días de gestión Maximo (promedio)',
        actual: days(a.dias_gestion.maximo.promedio_dias),
        anterior: days(b.dias_gestion.maximo.promedio_dias),
        nota: `De la creación de la solicitud (PR) a la OC · ${a.dias_gestion.maximo.total} OC del periodo con solicitud`,
      },
      {
        indicador: 'Días de gestión Maximo (mediana)',
        actual: days(a.dias_gestion.maximo.mediana_dias),
        anterior: days(b.dias_gestion.maximo.mediana_dias),
        nota: 'La mitad de las OC se gestionó en menos días que esto',
      },
      {
        indicador: 'Días de gestión ABENT (promedio)',
        actual: days(a.dias_gestion.abent),
        anterior: days(b.dias_gestion.abent),
        nota: 'Días hábiles de requisiciones cerradas',
      },
      {
        indicador: 'Pendientes de gestionar (solicitudes sin OC)',
        actual: a.solicitudes.pendientes,
        anterior: null,
        nota: `Al día de hoy · creadas desde ${dmy(a.solicitudes.pendientes_periodo.desde)} · SAP ${a.solicitudes.por_fuente.sap.pendientes} · Maximo ${a.solicitudes.por_fuente.maximo.pendientes ?? NO_DISPONIBLE}`,
      },
    );
    for (const row of openBalance) {
      rows.push({
        indicador: `Saldo por recibir de OC SAP abiertas (${row.currency ?? 'sin moneda'})`,
        actual: num(row.saldo),
        anterior: null,
        nota: `Al día de hoy · ${row.count} OC abiertas`,
        money: true,
      });
    }
    rows.push(
      {
        indicador: 'Entregas pendientes',
        actual: actual.entregas.pendientes,
        anterior: null,
        nota: 'Al día de hoy · en tiempo, en riesgo o sin fecha',
      },
      {
        indicador: 'Entregas vencidas',
        actual: actual.entregas.vencidas,
        anterior: null,
        nota: 'Al día de hoy',
      },
      {
        indicador: 'Autorizaciones pendientes en SAP',
        actual: tiempos.sap.pendientes.total,
        anterior: null,
        nota: 'Al día de hoy · detalle en la hoja "Autorizaciones SAP"',
      },
      {
        indicador: 'OC de Maximo en espera de aprobación',
        actual: tiempos.maximo_pendientes.total,
        anterior: null,
        nota: 'Al día de hoy',
      },
      {
        indicador: 'Contratos por vencer en 30 días',
        actual: a.contratos_por_vencer_30_dias.total,
        anterior: null,
        nota: `Al día de hoy · ABENT ${a.contratos_por_vencer_30_dias.por_fuente.abent}, Maximo ${a.contratos_por_vencer_30_dias.por_fuente.maximo}`,
      },
      {
        indicador: 'Proveedores bloqueados',
        actual: actual.proveedores.bloqueados,
        anterior: null,
        nota: 'Al día de hoy · bloqueados en ABENT por desempeño',
      },
    );
    return rows;
  }

  /** H1: KPIs de la página del avance semanal, uno por renglón. */
  private avanceRows(p: AvancePage): AvanceRow[] {
    const anio = p.semana.anio;
    const dias = (v: number | null) => (v === null ? 'Sin datos' : v);
    const { sap, maximo } = p.por_sistema;
    const split = (pick: (s: NonNullable<typeof sap>) => number) =>
      sap && maximo ? `SAP ${pick(sap)} · Maximo ${pick(maximo)}` : undefined;
    const join = (...parts: Array<string | undefined>) =>
      parts.filter(Boolean).join(' · ') || undefined;
    const rows: AvanceRow[] = [
      {
        indicador: 'Semana',
        valor: p.semana.etiqueta,
        nota: `Datos al domingo ${p.semana.corte}`,
      },
      { indicador: 'Fuente', valor: p.fuente.etiqueta },
      {
        indicador: `Gestiones recibidas en ${anio}`,
        valor: p.avance.recibidas_anio,
        nota: split((s) => s.recibidas_anio),
      },
      {
        indicador: 'Nuevas en la semana',
        valor: p.avance.nuevas_semana,
        nota: join(
          split((s) => s.nuevas_semana),
          p.avance.nuevas_aproximadas > 0
            ? `${p.avance.nuevas_aproximadas} PR de Maximo con fecha aproximada`
            : undefined,
        ),
      },
      {
        indicador: `Cerradas de las recibidas en ${anio}`,
        valor: p.avance.cerradas_anio,
        nota: split((s) => s.cerradas_anio),
      },
      {
        indicador: 'Cerradas en la semana',
        valor: p.avance.cerradas_semana,
        nota: join(
          split((s) => s.cerradas_semana),
          p.avance.cerradas_semana_anteriores > 0
            ? `${p.avance.cerradas_semana_anteriores} recibidas antes de ${anio}`
            : undefined,
        ),
      },
      {
        indicador: `Días de cierre ${anio} (promedio)`,
        valor: dias(p.cierre.anio.promedio_dias),
        nota: `De la solicitud a su primera OC · mediana ${p.cierre.anio.mediana_dias ?? 'sin datos'} · sobre ${p.cierre.anio.total} cerradas con OC`,
      },
      ...p.cierre.semanas.map((s) => ({
        indicador: `Días de cierre, semana ${s.etiqueta} (promedio)`,
        valor: dias(s.dias.promedio_dias),
        nota: `Mediana ${s.dias.mediana_dias ?? 'sin datos'} · ${s.cerradas} cerradas en la semana`,
      })),
    ];
    if (!p.cancelacion.disponible || !p.cancelacion.anio) {
      rows.push({
        indicador: `Días de cancelación ${anio} (promedio)`,
        valor: NO_DISPONIBLE,
        nota: p.cancelacion.nota ?? undefined,
      });
    } else {
      rows.push(
        {
          indicador: `Días de cancelación ${anio} (promedio)`,
          valor: dias(p.cancelacion.anio.promedio_dias),
          nota: join(
            p.cancelacion.nota ?? undefined,
            `mediana ${p.cancelacion.anio.mediana_dias ?? 'sin datos'} · sobre ${p.cancelacion.anio.total} canceladas`,
          ),
        },
        ...p.cancelacion.semanas.map((s) => ({
          indicador: `Días de cancelación, semana ${s.etiqueta} (promedio)`,
          valor: dias(s.dias.promedio_dias),
          nota: `Mediana ${s.dias.mediana_dias ?? 'sin datos'} · ${s.canceladas} canceladas en la semana`,
        })),
      );
    }
    const e = p.estado_anio;
    rows.push(
      {
        indicador: `Canceladas de las recibidas en ${anio}`,
        valor: p.fuente.clave === 'maximo' ? NO_DISPONIBLE : e.canceladas,
        nota: 'Solo SAP: Maximo no envía el estatus de las solicitudes',
      },
      {
        indicador: `Abiertas de las recibidas en ${anio} (SAP)`,
        valor: e.abiertas,
      },
      {
        indicador: `Sin OC de las recibidas en ${anio} (Maximo)`,
        valor: e.sin_oc,
        nota: 'Maximo no envía el estatus de las PR: pueden seguir abiertas o estar canceladas',
      },
      {
        indicador: `% atendidas de las recibidas en ${anio}`,
        valor: e.atendidas_pct ?? 'Sin datos',
        nota: 'Cerradas + canceladas entre recibidas',
      },
    );
    for (const c of p.anual) {
      rows.push(
        { indicador: `Recibidas en ${c.anio}`, valor: c.recibidas },
        {
          indicador: `Atendidas de ${c.anio}`,
          valor: c.atendidas,
          nota: `${c.atendidas_pct ?? 'sin datos'}% · ${c.cerradas} cerradas · ${c.canceladas} canceladas · ${c.abiertas} abiertas · ${c.sin_oc} sin OC`,
        },
      );
    }
    for (const moneda of p.montos.monedas) {
      for (const mes of p.montos.meses) {
        rows.push({
          indicador: `Monto adjudicado ${mes.etiqueta} ${p.montos.anio} (${moneda})`,
          valor: mes.montos[moneda] ?? 0,
          money: true,
        });
      }
      rows.push({
        indicador: `Monto adjudicado total ${p.montos.anio} (${moneda})`,
        valor: p.montos.total[moneda] ?? 0,
        nota: 'OC no canceladas, con IVA, por mes de la OC',
        money: true,
      });
    }
    return rows;
  }

  private approvalRow(row: PendingApprovalRow) {
    const approvers = Array.isArray(row.approvers)
      ? (row.approvers as SapApprovalLineView[])
      : [];
    const pendingNow = approvers
      .filter(
        (a) =>
          a.status === 'ardPending' &&
          (row.current_stage === null ||
            a.stage_code === null ||
            a.stage_code === row.current_stage),
      )
      .map((a) => a.user_name ?? 'Sin nombre en SAP');
    return {
      tipo:
        row.object_type === '22'
          ? 'OC'
          : row.object_type === '1470000113'
            ? 'Solicitud'
            : (row.object_type ?? ''),
      numero: row.doc_num,
      proveedor: row.card_name,
      monto: num(row.doc_total),
      moneda: row.currency,
      solicitante: row.requester_name ?? row.originator_name,
      etapa: row.current_stage_name,
      aprobadores: [...new Set(pendingNow)].join(', '),
      creada: row.creation_date,
      dias: row.dias === null ? null : Math.max(0, Number(row.dias)),
    };
  }
}
