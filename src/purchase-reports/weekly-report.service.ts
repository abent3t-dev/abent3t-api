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
import {
  maximoPrStatusWithCode,
  maximoStatusWithCode,
} from '../common/utils/maximo-status.util';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import {
  CURRENT_MAXIMO_POS,
  CURRENT_MAXIMO_PRS,
  MAXIMO_PRS_WITH_PO,
  maximoPrPending,
  montoBaseNota,
  TABLERO_MONTO_BASE,
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
import { PurchaseReportsService } from './purchase-reports.service';
import { AvanceSemanalService } from './avance-semanal/avance-semanal.service';
import {
  type AvancePage,
  buildAvancePage,
  fuentesDelReporte,
  lastCompleteWeek,
} from './avance-semanal/avance-semanal.engine';
import { montoBaseTexto } from './avance-semanal/avance-semanal.reglas';

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
 * RQ → OC por sistema (promedio y mediana); G3 pendientes = RQ sin OC; G7
 * etiquetas de estatus. K4.5 (2026-10-05): las PR de Maximo del periodo
 * son las creadas en él (ISSUEDATE), una por PR, con el estatus de la PR;
 * ya no se ubican por folio.
 *
 * 2026-09-29 (H1): hoja "Avance semanal" con los KPIs del PDF del reporte de
 * avance semanal (mismo motor), de la última semana completa del periodo.
 * I3 (2026-09-30): un bloque de Maximo y uno de SAP, como las dos páginas.
 * K5.6 (2026-10-05): canceladas y abiertas en las dos fuentes (sin "Sin
 * OC" ni fechas aproximadas) y los montos en la base de AVANCE_MONTO_BASE
 * con un renglón del otro valor.
 * K6.7 (2026-10-05): el Resumen trae los montos de OC en la base de
 * TABLERO_MONTO_BASE y un renglón "… sin IVA" (subtotal); las hojas OC SAP
 * y OC Maximo traen la columna "Subtotal (sin IVA)" junto a "Monto" (con
 * IVA). El saldo abierto y las autorizaciones de SAP se quedan con IVA a
 * propósito y lo dicen.
 */

const DAY_MS = 86_400_000;

/**
 * Columnas del detalle SAP que van al reporte (mismas etiquetas que el
 * export). Ojo: se eligen de SAP_PO_EXPORT_COLUMNS por el TEXTO del
 * encabezado (`pick`); un encabezado que no exista allá se cae sin error
 * (lo cuida una prueba). K6: "Monto" es el DocTotal con IVA y no se renombra.
 */
export const SAP_PO_HEADERS = [
  'Número',
  'Proveedor',
  'Estatus',
  'Monto',
  'Subtotal (sin IVA)',
  'Saldo disponible',
  'Moneda',
  'Solicitante',
  'Comprador',
  'Origen',
  'Capturó (SAP)',
  'F. Documento',
  'F. Entrega',
];
export const SAP_PR_HEADERS = [
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
  /** I3: título del bloque (Maximo / SAP). */
  seccion?: boolean;
}

interface MaximoPoRow {
  ponum: string;
  description: string | null;
  status: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  total_cost: unknown;
  /** K6: sin IVA (Σ POLINE.LINECOST); null = no disponible. */
  subtotal: unknown;
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
  /** K4.5: estatus DE LA PR (WAPPR, APPR, CLOSE, CAN). */
  pr_status: string | null;
  /** Estatus del contrato (sin contrato, el de la PR). */
  status: string | null;
  has_contract: boolean;
  /** G3: alguna OC vigente no cancelada usa la PR. */
  con_oc: boolean;
  /** K4: aprobada (APPR) sin OC ni contrato = pendiente de gestionar. */
  pendiente: boolean;
  vendor_name: string | null;
  contract_value: unknown;
  currency: string | null;
  requested_by: string | null;
  pr_issue_date: Date | null;
  pr_approved_at: Date | null;
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
        SELECT ponum, description, status, vendor_id, vendor_name, total_cost, subtotal,
               currency, requested_by, purchase_agent, purchase_agent_name, created_by,
               department, created_at_source, approved_at, approved_by
        FROM (${CURRENT_MAXIMO_POS}) current
        WHERE created_at_source BETWEEN ${period.from} AND ${periodTo}
        ORDER BY created_at_source DESC`),
      // K4.5: PR creadas en el periodo (ISSUEDATE), una por PR
      this.prisma.$queryRaw<MaximoPrRow[]>(Prisma.sql`
        SELECT p.prnum, p.contractnum, p.pr_status, p.status, p.has_contract,
               p.vendor_name, p.contract_value, p.currency, p.requested_by,
               p.pr_issue_date, p.pr_approved_at,
               (p.prnum IN (${MAXIMO_PRS_WITH_PO})) AS con_oc,
               ${maximoPrPending('p')} AS pendiente
        FROM (${CURRENT_MAXIMO_PRS}) p
        WHERE p.pr_issue_date BETWEEN ${period.from} AND ${periodTo}
        ORDER BY p.pr_issue_date DESC, p.prnum DESC`),
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
    // H1: última semana completa hasta el fin del periodo. I3: un bloque
    // por sistema (Maximo y SAP), homologados, en lugar del combinado.
    const avanceLunes = lastCompleteWeek(new Date(periodTo.getTime() + 1));
    const avanceGenerado = new Date();
    const avanceDatos = await avanceData;
    const avancePages = fuentesDelReporte('ambos').map((fuente) =>
      buildAvancePage(avanceDatos, avanceLunes, fuente, avanceGenerado),
    );
    const avanceSemana = avancePages[0].semana.etiqueta;
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
          avancePages.flatMap((page, i) => [
            ...(i > 0 ? [{ indicador: '', valor: null }] : []),
            {
              indicador: page.fuente.etiqueta,
              valor: `Reporte de avance semanal de ${page.fuente.etiqueta}`,
              seccion: true,
            },
            ...this.avanceRows(page),
          ]),
          { section: (r) => r.seccion === true },
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
            // TOTALCOST, con IVA (la nota lo dice)
            {
              header: 'Monto',
              value: (r) => num(r.total_cost),
              kind: 'money',
              width: 16,
            },
            // K6: Σ POLINE.LINECOST; sin líneas o alguna sin LINECOST →
            // "No disponible" (no se estima)
            {
              header: 'Subtotal (sin IVA)',
              value: (r) => num(r.subtotal) ?? NO_DISPONIBLE,
              kind: 'money',
              width: 18,
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
            // K4.5: estatus de la PR; el del contrato va aparte. K7: con el
            // mapa de las PR ("Aprobada: llegó a Compras (APPR)"), no el de OC
            {
              header: 'Estatus PR',
              value: (r) =>
                maximoPrStatusWithCode(r.pr_status) || NO_DISPONIBLE,
              width: 32,
            },
            {
              header: 'Estatus contrato',
              value: (r) => (r.has_contract ? maximoStatus(r.status) : null),
              width: 22,
            },
            {
              header: 'Con OC',
              value: (r) => (r.con_oc ? 'Sí' : 'No'),
              width: 10,
            },
            {
              header: 'Pendiente de gestionar',
              value: (r) =>
                r.pendiente ? 'Sí (aprobada, sin OC ni contrato)' : 'No',
              width: 30,
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
              header: 'Fecha PR (ISSUEDATE)',
              value: (r) => r.pr_issue_date,
              kind: 'date',
              width: 16,
            },
            // primer APPR de la PR: llegó a Compras
            {
              header: 'Aprobación PR',
              value: (r) => r.pr_approved_at,
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
            // K6.9: total del borrador, con IVA a propósito (sin líneas)
            {
              header: 'Monto (con IVA)',
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
        `Montos por moneda: nunca se suman MXN con USD o EUR. Resumen: montos de OC ${montoBaseNota(TABLERO_MONTO_BASE)}${TABLERO_MONTO_BASE === 'sin_iva' ? '' : ', con un renglón sin IVA (suma de las líneas, solo de las OC que la tienen; las propias de ABENT no la tienen)'}. Hojas "OC SAP" y "OC Maximo": "Monto" con IVA (DocTotal / TOTALCOST) en la moneda del documento y "Subtotal (sin IVA)" = suma de las líneas ("No disponible" si la OC no tiene líneas o a alguna le falta importe; no se estima). Solicitudes de SAP sin IVA (suma de sus líneas); autorizaciones de SAP con IVA (total del borrador). La hoja "Avance semanal", ${montoBaseTexto(avancePages[0].montos.base)} (con un renglón del otro valor).`,
        'Saldo disponible: parte de la OC de SAP aún no recibida ni facturada (cantidad pendiente de cada línea), con IVA.',
        'Solicitante de una OC de SAP: el de la solicitud de pedido de SAP de la que nació; si la OC viene de Maximo (columna "Origen"), el solicitante de Maximo; si no hay, queda vacío.',
        'Comprador: en Maximo es el comprador de la OC (PURCHASEAGENT); si no lo trae (casi todas), "Capturó: …" es quien creó la OC en Maximo. SAP no tiene comprador capturado en ninguna OC: las OC de SAP creadas desde Maximo muestran lo de Maximo y las demás "Capturó: …" (el usuario de SAP que la capturó).',
        'Solicitudes Maximo: las PR creadas en el periodo (fecha de la PR, ISSUEDATE), una fila por PR, con el estatus de la PR (el del contrato va aparte). "Pendiente de gestionar" = aprobadas (APPR) sin OC ni contrato; "Aprobación PR" es su primera aprobación (cuando llegó a Compras).',
        'Los indicadores marcados "al día de hoy" son una foto al generar el archivo, no del periodo; por eso no tienen columna anterior.',
        'Estado por aprobador: "Retrasado" cuando su pendiente más antigua ya rebasó su promedio histórico de autorización. Ambos cuentan desde que el documento le llegó a ese aprobador (la aprobación de la etapa anterior o la creación); "Días esperando" de la hoja de autorizaciones cuenta desde la creación.',
        `Avance semanal (${avanceSemana}): los mismos KPIs que el PDF "Reporte de avance semanal" de Reportes, un bloque por sistema (Maximo y SAP, homologados, por cohorte del año).`,
        ...avancePages.flatMap((page) =>
          page.notas.map(
            (nota) => `Avance semanal (${page.fuente.etiqueta}): ${nota}`,
          ),
        ),
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
        // H8: null = ninguna PR con estatus todavía (antes del primer full)
        actual: a.solicitudes.por_fuente.maximo.creadas ?? NO_DISPONIBLE,
        anterior: b.solicitudes.por_fuente.maximo.creadas ?? NO_DISPONIBLE,
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
    type Montos = typeof a.ordenes.monto_por_moneda;
    for (const currency of currencies) {
      const find = (list: Montos) => list.find((m) => m.currency === currency);
      const amount = (list: Montos) => find(list)?.total ?? 0;
      // K6: ninguna OC de la moneda con subtotal → "Sin datos", no 0
      const subtotal = (list: Montos) => {
        const m = find(list);
        if (!m) return 0;
        return (m.sin_subtotal ?? 0) >= m.count
          ? 'Sin datos'
          : (m.subtotal ?? 0);
      };
      rows.push({
        indicador: `Monto de OC creadas (${currency})`,
        actual: amount(a.ordenes.monto_por_moneda),
        anterior: amount(b.ordenes.monto_por_moneda),
        nota: `OC no canceladas, ${montoBaseNota(TABLERO_MONTO_BASE)}`,
        money: true,
      });
      if (TABLERO_MONTO_BASE !== 'sin_iva') {
        const sinSubtotal = find(a.ordenes.monto_por_moneda)?.sin_subtotal;
        rows.push({
          indicador: `Monto de OC creadas (${currency}), sin IVA`,
          actual: subtotal(a.ordenes.monto_por_moneda),
          anterior: subtotal(b.ordenes.monto_por_moneda),
          nota: `Suma de las líneas, solo de las OC con subtotal${sinSubtotal ? ` · ${sinSubtotal} OC del periodo sin subtotal no suman (sin líneas o con alguna sin importe, y las propias de ABENT)` : ''}`,
          money: true,
        });
      }
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
        // K4: en Maximo, aprobadas (APPR) sin OC ni contrato, por su aprobación
        nota: `Al día de hoy · desde ${dmy(a.solicitudes.pendientes_periodo.desde)} · SAP ${a.solicitudes.por_fuente.sap.pendientes} (sin OC) · Maximo ${a.solicitudes.por_fuente.maximo.pendientes ?? NO_DISPONIBLE} (aprobadas, APPR, sin OC ni contrato)`,
      },
    );
    for (const row of openBalance) {
      rows.push({
        indicador: `Saldo por recibir de OC SAP abiertas (${row.currency ?? 'sin moneda'})`,
        actual: num(row.saldo),
        anterior: null,
        // K6.9: el saldo se queda con IVA a propósito
        nota: `Al día de hoy · ${row.count} OC abiertas · con IVA`,
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
    const noRecibidas = p.avance.maximo_no_recibidas;
    const rows: AvanceRow[] = [
      {
        indicador: 'Semana',
        valor: p.semana.etiqueta,
        nota: `Datos al ${p.semana.corte_dia} ${p.semana.corte}`,
      },
      { indicador: 'Fuente', valor: p.fuente.etiqueta },
      {
        indicador: `Gestiones recibidas en ${anio}`,
        valor: p.avance.recibidas_anio,
        nota: join(
          split((s) => s.recibidas_anio),
          noRecibidas && p.opciones.reglas.recibida === 'aprobacion'
            ? `${noRecibidas} ${noRecibidas === 1 ? 'PR de Maximo emitida sin aprobar va' : 'PR de Maximo emitidas sin aprobar van'} aparte`
            : undefined,
        ),
      },
      {
        indicador: 'Nuevas en la semana',
        valor: p.avance.nuevas_semana,
        nota: split((s) => s.nuevas_semana),
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
        nota: `${p.cierre.nota} · mediana ${p.cierre.anio.mediana_dias ?? 'sin datos'} · sobre ${p.cierre.anio.total} cerradas con OC`,
      },
      ...p.cierre.semanas.map((s) => ({
        indicador: `Días de cierre, semana ${s.etiqueta} (promedio)`,
        valor: dias(s.dias.promedio_dias),
        nota: `Mediana ${s.dias.mediana_dias ?? 'sin datos'} · ${s.cerradas} cerradas en la semana`,
      })),
    ];
    // K5: la cancelación ya trae dato en las dos fuentes
    const cancel = p.cancelacion.anio;
    rows.push(
      {
        indicador: `Días de cancelación ${anio} (promedio)`,
        valor: dias(cancel?.promedio_dias ?? null),
        nota: join(
          p.cancelacion.nota ?? undefined,
          `mediana ${cancel?.mediana_dias ?? 'sin datos'} · sobre ${cancel?.total ?? 0} canceladas`,
        ),
      },
      ...p.cancelacion.semanas.map((s) => ({
        indicador: `Días de cancelación, semana ${s.etiqueta} (promedio)`,
        valor: dias(s.dias.promedio_dias),
        nota: `Mediana ${s.dias.mediana_dias ?? 'sin datos'} · ${s.canceladas} canceladas en la semana`,
      })),
    );
    const e = p.estado_anio;
    rows.push(
      {
        indicador: `Canceladas de las recibidas en ${anio}`,
        valor: e.canceladas,
      },
      {
        indicador: `Abiertas de las recibidas en ${anio}`,
        valor: e.abiertas,
        nota: 'Recibidas sin cerrar ni cancelar al corte',
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
          nota: `${c.atendidas_pct ?? 'sin datos'}% · ${c.cerradas} cerradas · ${c.canceladas} canceladas · ${c.abiertas} abiertas`,
        },
      );
    }
    // K5: montos en la base de AVANCE_MONTO_BASE y un renglón del otro valor
    const m = p.montos;
    const base = montoBaseTexto(m.base);
    const otro = montoBaseTexto(m.otro.base);
    for (const moneda of m.monedas) {
      if (m.total[moneda] !== undefined) {
        for (const mes of m.meses) {
          // H9: sin valor y con OC sin subtotal = No disponible (no $0, que
          // es un mes sin compras); con valor, las que faltan van en la nota
          const v = mes.montos[moneda];
          const faltan = mes.sin_subtotal[moneda] ?? 0;
          const sinBase = m.base === 'sin_iva' && faltan > 0;
          rows.push({
            indicador: `Monto adjudicado ${mes.etiqueta} ${m.anio} (${moneda})`,
            valor: v ?? (sinBase ? NO_DISPONIBLE : 0),
            money: v !== undefined || !sinBase,
            nota: sinBase
              ? `${faltan} ${faltan === 1 ? 'OC sin subtotal no suma' : 'OC sin subtotal no suman'} (no se estiman)`
              : undefined,
          });
        }
      }
      rows.push(
        {
          indicador: `Monto adjudicado total ${m.anio} (${moneda})`,
          valor: m.total[moneda] ?? 'Sin datos',
          nota: `OC no canceladas, ${base}, por mes de la OC`,
          money: m.total[moneda] !== undefined,
        },
        {
          indicador: `Monto adjudicado total ${m.anio} (${moneda}), ${otro}`,
          valor: m.otro.total[moneda] ?? 'Sin datos',
          nota:
            m.otro.base === 'sin_iva'
              ? 'El mismo total sin IVA (suma de las líneas), de las OC con subtotal'
              : 'El mismo total con IVA, de todas las OC',
          money: m.otro.total[moneda] !== undefined,
        },
      );
    }
    if (m.sin_subtotal.ordenes > 0) {
      rows.push({
        indicador: `OC sin subtotal ${m.anio}`,
        valor: m.sin_subtotal.ordenes,
        nota: 'Sin líneas o con alguna sin importe: no entran a los montos sin IVA (no se estiman)',
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
