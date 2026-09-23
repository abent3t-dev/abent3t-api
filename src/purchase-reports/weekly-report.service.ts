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

/**
 * Reporte semanal de Compras (Ingrid, 2026-09-23): un Excel con el resumen
 * del periodo contra el periodo anterior de la misma duración y el detalle
 * de lo que se movió (OC y solicitudes de SAP y Maximo creadas en el
 * periodo, autorizaciones pendientes y quién las tiene).
 *
 * Solo lectura: reutiliza el resumen de Reportes (una sola definición por
 * métrica) y el listado de SAP (saldo y solicitante incluidos). Montos por
 * moneda, nunca sumados entre monedas; sin dato = "Sin datos", nunca 0.
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
  'OC Maximo',
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

const MAXIMO_STATUS: Record<string, string> = {
  APPR: 'Aprobada',
  WAPPR: 'En espera de aprobación',
  PNDREV: 'Pendiente de revisión',
  REVISD: 'Revisada',
  INPRG: 'En progreso',
  COMP: 'Completada',
  CLOSE: 'Cerrada',
  CAN: 'Cancelada',
  CANCEL: 'Cancelada',
  DRAFT: 'Borrador',
};
const maximoStatus = (status: string | null) =>
  (status && MAXIMO_STATUS[status]) || status || '';

interface SummaryRow {
  indicador: string;
  actual: number | string | null;
  anterior: number | string | null;
  nota?: string;
  money?: boolean;
}

interface MaximoPoRow {
  ponum: string;
  description: string | null;
  status: string | null;
  vendor_name: string | null;
  total_cost: unknown;
  currency: string | null;
  requested_by: string | null;
  department: string | null;
  created_at_source: Date | null;
  approved_at: Date | null;
  approved_by: string | null;
}

interface MaximoPrRow {
  prnum: string | null;
  contractnum: string | null;
  status: string | null;
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
  /** Días naturales desde la creación (misma cuenta que "por aprobador"). */
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
        SELECT ponum, description, status, vendor_name, total_cost, currency,
               requested_by, department, created_at_source, approved_at, approved_by
        FROM (${CURRENT_MAXIMO_POS}) current
        WHERE created_at_source BETWEEN ${period.from} AND ${periodTo}
        ORDER BY created_at_source DESC`),
      this.prisma.$queryRaw<MaximoPrRow[]>(Prisma.sql`
        SELECT prnum, contractnum, status, vendor_name, contract_value, currency,
               requested_by, created_at_source, approved_at
        FROM (${CURRENT_MAXIMO_CONTRACTS}) current
        WHERE prnum IS NOT NULL
          AND created_at_source BETWEEN ${period.from} AND ${periodTo}
        ORDER BY created_at_source DESC`),
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

    const summary = this.summaryRows(actual, anterior, tiempos, openBalance);
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
        excelSheet<MaximoPoRow>(
          'OC Maximo',
          [
            { header: 'PONUM', value: (r) => r.ponum, width: 14 },
            { header: 'Descripción', value: (r) => r.description, width: 44 },
            {
              header: 'Estatus',
              value: (r) => maximoStatus(r.status),
              width: 22,
            },
            { header: 'Proveedor', value: (r) => r.vendor_name, width: 36 },
            {
              header: 'Monto',
              value: (r) => num(r.total_cost),
              kind: 'money',
              width: 16,
            },
            { header: 'Moneda', value: (r) => r.currency, width: 10 },
            {
              header: 'Solicitado por',
              value: (r) => r.requested_by,
              width: 18,
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
            { header: 'Aprobó', value: (r) => r.approved_by, width: 14 },
          ],
          maximoPos,
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
        'Solicitante de una OC de SAP: el de la solicitud de pedido de SAP de la que nació; si la OC viene de Maximo (columna "OC Maximo"), el solicitante de Maximo. Las demás muestran solo quién la capturó.',
        'Los indicadores marcados "al día de hoy" son una foto al generar el archivo, no del periodo; por eso no tienen columna anterior.',
        'Estado por aprobador: "Retrasado" cuando su pendiente más antigua ya rebasó su promedio histórico de autorización.',
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
      {
        indicador: 'Días de gestión SAP (promedio)',
        actual: days(a.dias_gestion.sap),
        anterior: days(b.dias_gestion.sap),
        nota: 'Solicitudes cerradas: de la fecha del documento al cierre',
      },
      {
        indicador: 'Días de gestión Maximo (promedio)',
        actual: days(a.dias_gestion.maximo),
        anterior: days(b.dias_gestion.maximo),
        nota: 'De la solicitud a su aprobación',
      },
      {
        indicador: 'Días de gestión ABENT (promedio)',
        actual: days(a.dias_gestion.abent),
        anterior: days(b.dias_gestion.abent),
        nota: 'Días hábiles de requisiciones cerradas',
      },
      {
        indicador: 'Solicitudes abiertas',
        actual: a.solicitudes.abiertas,
        anterior: null,
        nota: 'Al día de hoy',
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
