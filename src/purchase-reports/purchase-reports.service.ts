import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ExpeditingService } from '../expediting/expediting.service';
import { PurchaseCommitteesService } from '../purchase-committees/purchase-committees.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import { maximoVendorAmounts, rankVendors, VendorAmount } from './vendor-tops';
import {
  andMaximoPrInWindow,
  andSapPoCountedOnce,
  loadMaximoPrFolioWindow,
  maximoInApproval,
  maximoStatusSince,
  pendingWindowStart,
} from '../common/sql/erp-views.sql';
import {
  maximoGestionDays,
  sapGestionDays,
} from '../purchase-dashboard/sap-gestion-days';
import type { SapGestionResult } from '../purchase-dashboard/sap-gestion-days';
import { loadPendingRequests } from '../purchase-dashboard/pending-requests';
import {
  maximoApproverEvents,
  sapApproverEvents,
  summarizeApprovers,
} from './approver-stats';
import { loadMaximoApprovals, loadSapApprovalDocs } from './approver-data';
import { ReportPeriodDto } from './dto/report-period.dto';

/**
 * Fase Reportes — SOLO lectura y SOLO agregación (regla 1): agrega sobre las
 * tablas propias y el staging de la integración (lectura Prisma, patrón
 * Int-5), y CONSUME las fórmulas existentes en vez de crear variantes
 * (regla 3): aprobaciones → ApprovalsService.getStats(), entregas →
 * ExpeditingService.getStats(), comité → dashboardTiempos(). Esas tres
 * fórmulas son ACUMULADAS (no reciben periodo) y así se reportan.
 *
 * Ahorro (T10): por FUENTE, nunca sumado. El modelo propio no tiene campo de
 * ahorro → solo se reporta el de Maximo (AB_AHORRO del staging), por moneda
 * y con el conteo "sin clasificar" visible (§20.A.1, regla 6).
 *
 * Bloque 2026-09-23: D1 (las OC de SAP migradas desde Maximo que existen en
 * Maximo se cuentan una vez: fuera de las series/totales de SAP), D3 (días
 * de gestión de OC SAP = OC − solicitud base, en tiempos), D6 (alias de
 * usuarios SAP/Maximo en aprobadores y niveles del flujo propio).
 *
 * Reunión con Ingrid 2026-09-28 (G1): tops de proveedores con código; el de
 * Maximo por proveedor EFECTIVO (según SAP cuando la OC migró o por cruce de
 * código) y un top SAP + Maximo contado una vez — ver vendor-tops.ts.
 */

const MAX_RANGE_MONTHS = 24;
const DEFAULT_RANGE_MONTHS = 12;

export interface ReportPeriod {
  from: Date;
  to: Date;
}

interface MonthCount {
  month: Date | null;
  count: number;
}

/** Vista actual del staging (misma definición que Int-5/maximo-records). */
export const CURRENT_MAXIMO_POS = Prisma.sql`
  SELECT DISTINCT ON (ponum, coalesce(siteid, '')) *
  FROM maximo_purchase_orders
  ORDER BY ponum, coalesce(siteid, ''), coalesce(revisionnum, 0) DESC`;

export const CURRENT_MAXIMO_CONTRACTS = Prisma.sql`
  SELECT DISTINCT ON (coalesce(prnum, ''), coalesce(contractnum, '')) *
  FROM maximo_contracts
  ORDER BY coalesce(prnum, ''), coalesce(contractnum, ''),
    coalesce(revisionnum, 0) DESC`;

function toNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** G2: lo que viaja de la gestión en el resumen (promedio, mediana y N). */
const gestionOut = (g: SapGestionResult) => ({
  promedio_dias: g.promedio_dias,
  mediana_dias: g.mediana_dias,
  total: g.total,
});

/** Días con 1 decimal; null = sin base (nunca 0). */
function roundDays(value: unknown): number | null {
  const n = toNumber(value);
  return n === null ? null : Math.round(n * 10) / 10;
}

/** Roles del flujo propio por nivel (mismo orden que ApprovalsService). */
const ABENT_LEVEL_ROLES = [
  { level: 1, role: 'aprobador_nivel_1' as const },
  { level: 2, role: 'aprobador_nivel_2' as const },
  { level: 3, role: 'aprobador_nivel_3' as const },
  { level: 4, role: 'director_general' as const },
];

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Serie mensual con meses vacíos en cero dentro del periodo. */
function zeroFilledMonths(period: ReportPeriod): string[] {
  const months: string[] = [];
  const cursor = new Date(
    Date.UTC(period.from.getUTCFullYear(), period.from.getUTCMonth(), 1),
  );
  const end = new Date(
    Date.UTC(period.to.getUTCFullYear(), period.to.getUTCMonth(), 1),
  );
  while (cursor.getTime() <= end.getTime()) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function seriesFrom(
  period: ReportPeriod,
  rows: MonthCount[],
  extra: Array<{ key: string; rows: MonthCount[] }> = [],
) {
  const base = zeroFilledMonths(period).map((month) => {
    const entry: Record<string, unknown> = { month, count: 0 };
    for (const { key } of extra) entry[key] = 0;
    return entry;
  });
  const byMonth = new Map(base.map((e) => [e.month as string, e]));
  for (const row of rows) {
    if (!row.month) continue;
    const entry = byMonth.get(monthKey(row.month));
    if (entry) entry.count = Number(row.count);
  }
  for (const { key, rows: extraRows } of extra) {
    for (const row of extraRows) {
      if (!row.month) continue;
      const entry = byMonth.get(monthKey(row.month));
      if (entry) entry[key] = Number(row.count);
    }
  }
  return base;
}

@Injectable()
export class PurchaseReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalsService: ApprovalsService,
    private readonly expeditingService: ExpeditingService,
    private readonly committeesService: PurchaseCommitteesService,
    private readonly aliases: ErpAliasesService,
    private readonly vendors: MaximoVendorXrefService,
  ) {}

  /** Default: últimos 12 meses. Tope: 24 (regla 5). */
  resolvePeriod(dto: ReportPeriodDto): ReportPeriod {
    // Un `to` de solo fecha incluye el día completo (una OC de Maximo creada
    // el domingo a mediodía sí entra en la semana que termina el domingo).
    const to = dto.to
      ? /^\d{4}-\d{2}-\d{2}$/.test(dto.to)
        ? new Date(`${dto.to}T23:59:59.999Z`)
        : new Date(dto.to)
      : new Date();
    const from = dto.from
      ? new Date(dto.from)
      : new Date(
          Date.UTC(
            to.getUTCFullYear(),
            to.getUTCMonth() - DEFAULT_RANGE_MONTHS + 1,
            1,
          ),
        );
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('El rango es inválido: from > to');
    }
    const months =
      (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
      (to.getUTCMonth() - from.getUTCMonth());
    if (months >= MAX_RANGE_MONTHS) {
      throw new BadRequestException(
        `El rango máximo del reporte es de ${MAX_RANGE_MONTHS} meses`,
      );
    }
    return { from, to };
  }

  private periodOut(period: ReportPeriod) {
    return {
      from: period.from.toISOString().slice(0, 10),
      to: period.to.toISOString().slice(0, 10),
    };
  }

  // ── Resumen (KPIs cabecera) ─────────────────────────────────────────────

  async getResumen(dto: ReportPeriodDto) {
    const period = this.resolvePeriod(dto);
    const [
      rqsCreadas,
      rqsAbiertas,
      avgGestion,
      posAgg,
      contratosPorVencer,
      valorVigentes,
      proveedoresBloqueados,
      entregas,
    ] = await Promise.all([
      this.prisma.requisitions.count({
        where: {
          is_active: true,
          created_date: { gte: period.from, lte: period.to },
        },
      }),
      this.prisma.requisitions.count({
        where: {
          is_active: true,
          status: {
            in: ['en_revision', 'en_aprobacion', 'aprobada', 'en_progreso'],
          },
        },
      }),
      this.prisma.requisitions.aggregate({
        where: {
          is_active: true,
          closed_date: { gte: period.from, lte: period.to },
        },
        _avg: { business_days_elapsed: true },
      }),
      this.prisma.purchase_orders.aggregate({
        where: {
          is_active: true,
          created_at: { gte: period.from, lte: period.to },
          status: { not: 'cancelada' },
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.contracts.count({
        where: {
          is_active: true,
          status: 'vigente',
          end_date: {
            gte: new Date(),
            lte: new Date(Date.now() + 30 * 86_400_000),
          },
        },
      }),
      // I6: por moneda (la base real trae MXN, USD y EUR; nunca se suman)
      this.vigentesPorMoneda(),
      this.prisma.suppliers.count({
        where: { is_active: true, is_blocked: true },
      }),
      // Fórmula existente de expeditación (acumulada, regla 3)
      this.expeditingService.getStats(),
    ]);
    const erp = await this.resumenErp(period);
    const abentMontos = {
      currency: 'MXN',
      count: posAgg._count._all,
      total: toNumber(posAgg._sum.amount) ?? 0,
    };
    const montoPorMoneda = new Map<
      string,
      { currency: string; total: number; count: number }
    >();
    for (const row of [...erp.montos, abentMontos]) {
      if (row.count === 0) continue;
      const key = row.currency ?? 'sin_moneda';
      const acc = montoPorMoneda.get(key) ?? {
        currency: key,
        total: 0,
        count: 0,
      };
      acc.total = Math.round((acc.total + row.total) * 100) / 100;
      acc.count += row.count;
      montoPorMoneda.set(key, acc);
    }
    const abentDias = roundDays(avgGestion._avg.business_days_elapsed);

    return {
      periodo: this.periodOut(period),
      requisiciones: {
        creadas_en_periodo: rqsCreadas,
        abiertas_actuales: rqsAbiertas,
        promedio_dias_gestion:
          toNumber(avgGestion._avg.business_days_elapsed) ?? null,
      },
      ordenes: {
        creadas_en_periodo: posAgg._count._all,
        monto_total: toNumber(posAgg._sum.amount) ?? 0,
      },
      // Sprint 2026-09-22: las tarjetas de cabecera suman SAP + Maximo +
      // propias (antes solo propias → todo en cero).
      todas_las_fuentes: {
        // G3: pendientes de gestionar = RQ sin OC (al día de hoy, últimos
        // 12 meses); Maximo null = sin fechas de PR para ubicarlas
        solicitudes: {
          creadas: erp.sap.rq_creadas + erp.maximo.rq_creadas + rqsCreadas,
          pendientes:
            erp.sap.rq_pendientes +
            (erp.maximo.rq_pendientes ?? 0) +
            rqsAbiertas,
          por_fuente: {
            sap: {
              creadas: erp.sap.rq_creadas,
              pendientes: erp.sap.rq_pendientes,
            },
            maximo: {
              creadas: erp.maximo.rq_creadas,
              pendientes: erp.maximo.rq_pendientes,
            },
            abent: { creadas: rqsCreadas, pendientes: rqsAbiertas },
          },
          pendientes_periodo: erp.pendientes_periodo,
        },
        // G2: una definición por sistema (de la RQ a la OC, OC del periodo)
        dias_gestion: {
          sap: gestionOut(erp.sap.gestion),
          maximo: gestionOut(erp.maximo.gestion),
          abent: abentDias,
        },
        ordenes: {
          total: erp.sap.oc + erp.maximo.oc + posAgg._count._all,
          monto_por_moneda: Array.from(montoPorMoneda.values()).sort(
            (a, b) => b.count - a.count,
          ),
          por_fuente: {
            sap: erp.sap.oc,
            maximo: erp.maximo.oc,
            abent: posAgg._count._all,
          },
        },
        contratos_por_vencer_30_dias: {
          total: contratosPorVencer + erp.maximo.contratos_por_vencer,
          por_fuente: {
            abent: contratosPorVencer,
            maximo: erp.maximo.contratos_por_vencer,
          },
        },
      },
      entregas: {
        pendientes:
          entregas.counts.en_tiempo +
          entregas.counts.en_riesgo +
          entregas.counts.sin_fecha,
        vencidas: entregas.counts.retrasada,
        entregadas: entregas.counts.entregada,
        retraso_promedio_dias: entregas.avg_delay_days,
      },
      contratos: {
        por_vencer_30_dias: contratosPorVencer,
        valor_vigentes_por_moneda: valorVigentes,
      },
      proveedores: { bloqueados: proveedoresBloqueados },
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Parte ERP del resumen: solicitudes creadas (SAP por doc_date; Maximo PR
   * ubicadas por folio, G3), pendientes de gestionar (G3), días de gestión de
   * las OC del periodo (G2, misma definición que el dashboard), OC por
   * moneda y contratos de Maximo que vencen en 30 días.
   */
  private async resumenErp(period: ReportPeriod) {
    type CountsRow = {
      sap_rq_creadas: number;
      maximo_rq_creadas: number;
      maximo_contratos_por_vencer: number;
    };
    type GestionPoRow = {
      doc_entry: number;
      doc_date: Date | null;
      base_request_entries: number[];
    };
    const [prWindow, pending] = await Promise.all([
      loadMaximoPrFolioWindow(
        this.prisma,
        period.from,
        new Date(period.to.getTime() + 1),
      ),
      loadPendingRequests(this.prisma, pendingWindowStart(), null),
    ]);
    type MontoRow = {
      fuente: 'sap' | 'maximo';
      currency: string | null;
      count: number;
      total: unknown;
    };
    const [counts, montos, gestionPos, maximoGestion] = await Promise.all([
      this.prisma.$queryRaw<CountsRow[]>(Prisma.sql`
        WITH current_contracts AS (${CURRENT_MAXIMO_CONTRACTS})
        SELECT
          (SELECT count(*) FROM sap_purchase_requests
            WHERE cancelled IS DISTINCT FROM true
              AND doc_date BETWEEN ${period.from} AND ${period.to})::int AS sap_rq_creadas,
          (SELECT count(*) FROM current_contracts c
            WHERE c.prnum IS NOT NULL
              ${andMaximoPrInWindow('c', prWindow)})::int AS maximo_rq_creadas,
          (SELECT count(*) FROM current_contracts
            WHERE contractnum IS NOT NULL
              AND coalesce(status, '') NOT IN ('CAN', 'CANCEL', 'CLOSE')
              AND end_date BETWEEN now() AND now() + interval '30 days')::int AS maximo_contratos_por_vencer`),
      this.prisma.$queryRaw<MontoRow[]>(Prisma.sql`
        SELECT 'sap' AS fuente, currency, count(*)::int AS count,
               coalesce(sum(doc_total), 0) AS total
        FROM sap_purchase_orders
        WHERE cancelled IS DISTINCT FROM true
          AND doc_date BETWEEN ${period.from} AND ${period.to}
          ${andSapPoCountedOnce('sap_purchase_orders')}
        GROUP BY currency
        UNION ALL
        SELECT 'maximo' AS fuente, currency, count(*)::int AS count,
               coalesce(sum(total_cost), 0) AS total
        FROM (${CURRENT_MAXIMO_POS}) current
        WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL')
          AND created_at_source BETWEEN ${period.from} AND ${period.to}
        GROUP BY currency`),
      // G2: gestión de las OC del periodo (SAP: OC − solicitud base)
      this.prisma.$queryRaw<GestionPoRow[]>(Prisma.sql`
        SELECT doc_entry, doc_date, base_request_entries
        FROM sap_purchase_orders
        WHERE cancelled IS DISTINCT FROM true
          AND cardinality(base_request_entries) > 0
          AND doc_date BETWEEN ${period.from} AND ${period.to}`),
      // G2: Maximo: fecha de la OC − PR.ISSUEDATE
      this.prisma.$queryRaw<Array<{ dias: unknown }>>(Prisma.sql`
        SELECT CASE WHEN pr_issue_date IS NOT NULL
                    THEN extract(epoch FROM (created_at_source - pr_issue_date)) / 86400
               END AS dias
        FROM (${CURRENT_MAXIMO_POS}) current
        WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL')
          AND created_at_source BETWEEN ${period.from} AND ${period.to}`),
    ]);
    const requestEntries = [
      ...new Set(gestionPos.flatMap((po) => po.base_request_entries)),
    ];
    const gestionPrs =
      requestEntries.length === 0
        ? []
        : await this.prisma.$queryRaw<
            Array<{ doc_entry: number; doc_date: Date | null }>
          >(Prisma.sql`
            SELECT doc_entry, doc_date FROM sap_purchase_requests
            WHERE doc_entry IN (${Prisma.join(requestEntries)})`);
    const row = counts[0];
    const ocDe = (fuente: MontoRow['fuente']) =>
      montos
        .filter((m) => m.fuente === fuente)
        .reduce((sum, m) => sum + Number(m.count), 0);
    return {
      sap: {
        rq_creadas: Number(row?.sap_rq_creadas ?? 0),
        rq_pendientes: pending.sap.pendientes,
        gestion: sapGestionDays(gestionPos, gestionPrs),
        oc: ocDe('sap'),
      },
      maximo: {
        rq_creadas:
          prWindow.lower === null ? 0 : Number(row?.maximo_rq_creadas ?? 0),
        rq_pendientes: pending.maximo.pendientes,
        gestion: maximoGestionDays(maximoGestion),
        oc: ocDe('maximo'),
        contratos_por_vencer: Number(row?.maximo_contratos_por_vencer ?? 0),
      },
      pendientes_periodo: { desde: pending.desde, hasta: pending.hasta },
      montos: montos.map((m) => ({
        currency: m.currency,
        count: Number(m.count),
        total: toNumber(m.total) ?? 0,
      })),
    };
  }

  // ── Requisiciones ───────────────────────────────────────────────────────

  async getRequisiciones(dto: ReportPeriodDto) {
    const period = this.resolvePeriod(dto);
    const [creadas, cerradas, porEstatus, porTipo, porDepartamento] =
      await Promise.all([
        this.prisma.$queryRaw<MonthCount[]>(Prisma.sql`
          SELECT date_trunc('month', created_date) AS month, count(*)::int AS count
          FROM requisitions
          WHERE is_active = true
            AND created_date BETWEEN ${period.from} AND ${period.to}
          GROUP BY 1`),
        this.prisma.$queryRaw<MonthCount[]>(Prisma.sql`
          SELECT date_trunc('month', closed_date) AS month, count(*)::int AS count
          FROM requisitions
          WHERE is_active = true AND closed_date IS NOT NULL
            AND closed_date BETWEEN ${period.from} AND ${period.to}
          GROUP BY 1`),
        this.prisma.$queryRaw<
          Array<{ status: string | null; count: number; monto: unknown }>
        >(Prisma.sql`
          SELECT status::text AS status, count(*)::int AS count,
                 coalesce(sum(estimated_amount), 0) AS monto
          FROM requisitions
          WHERE is_active = true
            AND created_date BETWEEN ${period.from} AND ${period.to}
          GROUP BY status ORDER BY count DESC`),
        this.prisma.$queryRaw<
          Array<{ expense_type: string | null; count: number; monto: unknown }>
        >(Prisma.sql`
          SELECT expense_type::text AS expense_type, count(*)::int AS count,
                 coalesce(sum(estimated_amount), 0) AS monto
          FROM requisitions
          WHERE is_active = true
            AND created_date BETWEEN ${period.from} AND ${period.to}
          GROUP BY expense_type`),
        this.prisma.$queryRaw<
          Array<{ departamento: string | null; count: number }>
        >(Prisma.sql`
          SELECT d.name AS departamento, count(*)::int AS count
          FROM requisitions r
          LEFT JOIN departments d ON d.id = r.department_id
          WHERE r.is_active = true
            AND r.created_date BETWEEN ${period.from} AND ${period.to}
          GROUP BY d.name ORDER BY count DESC LIMIT 10`),
      ]);

    return {
      periodo: this.periodOut(period),
      serie_mensual: seriesFrom(period, creadas, [
        { key: 'cerradas', rows: cerradas },
      ]).map((entry) => ({
        month: entry.month,
        creadas: entry.count,
        cerradas: entry.cerradas,
      })),
      por_estatus: porEstatus.map((row) => ({
        status: row.status ?? 'sin_clasificar',
        count: row.count,
        monto: toNumber(row.monto) ?? 0,
      })),
      por_tipo: porTipo.map((row) => ({
        expense_type: row.expense_type ?? 'sin_clasificar',
        count: row.count,
        monto: toNumber(row.monto) ?? 0,
      })),
      por_departamento: porDepartamento.map((row) => ({
        departamento: row.departamento ?? 'Sin departamento',
        count: row.count,
      })),
      generated_at: new Date().toISOString(),
    };
  }

  // ── Órdenes y montos ────────────────────────────────────────────────────

  async getOrdenes(dto: ReportPeriodDto) {
    const period = this.resolvePeriod(dto);
    const [serie, porTipoCompra, porTipoGasto, topProveedores] =
      await Promise.all([
        this.prisma.$queryRaw<
          Array<{ month: Date | null; count: number; monto: unknown }>
        >(Prisma.sql`
          SELECT date_trunc('month', created_at) AS month, count(*)::int AS count,
                 coalesce(sum(amount), 0) AS monto
          FROM purchase_orders
          WHERE is_active = true AND status <> 'cancelada'
            AND created_at BETWEEN ${period.from} AND ${period.to}
          GROUP BY 1`),
        this.prisma.$queryRaw<
          Array<{ tipo: string | null; count: number; monto: unknown }>
        >(Prisma.sql`
          SELECT pt.name AS tipo, count(*)::int AS count,
                 coalesce(sum(po.amount), 0) AS monto
          FROM purchase_orders po
          LEFT JOIN purchase_types pt ON pt.id = po.purchase_type_id
          WHERE po.is_active = true AND po.status <> 'cancelada'
            AND po.created_at BETWEEN ${period.from} AND ${period.to}
          GROUP BY pt.name ORDER BY monto DESC`),
        this.prisma.$queryRaw<
          Array<{ expense_type: string | null; count: number; monto: unknown }>
        >(Prisma.sql`
          SELECT expense_type::text AS expense_type, count(*)::int AS count,
                 coalesce(sum(amount), 0) AS monto
          FROM purchase_orders
          WHERE is_active = true AND status <> 'cancelada'
            AND created_at BETWEEN ${period.from} AND ${period.to}
          GROUP BY expense_type`),
        this.prisma.$queryRaw<
          Array<{ proveedor: string; count: number; monto: unknown }>
        >(Prisma.sql`
          SELECT s.legal_name AS proveedor, count(*)::int AS count,
                 coalesce(sum(po.amount), 0) AS monto
          FROM purchase_orders po
          JOIN suppliers s ON s.id = po.supplier_id
          WHERE po.is_active = true AND po.status <> 'cancelada'
            AND po.created_at BETWEEN ${period.from} AND ${period.to}
          GROUP BY s.legal_name ORDER BY monto DESC LIMIT 10`),
      ]);

    const monthsBase = zeroFilledMonths(period).map((month) => ({
      month,
      count: 0,
      monto: 0,
    }));
    const byMonth = new Map(monthsBase.map((e) => [e.month, e]));
    for (const row of serie) {
      if (!row.month) continue;
      const entry = byMonth.get(monthKey(row.month));
      if (entry) {
        entry.count = Number(row.count);
        entry.monto = toNumber(row.monto) ?? 0;
      }
    }

    return {
      periodo: this.periodOut(period),
      serie_mensual: monthsBase,
      por_tipo_compra: porTipoCompra.map((row) => ({
        tipo: row.tipo ?? 'Sin tipo',
        count: row.count,
        monto: toNumber(row.monto) ?? 0,
      })),
      por_tipo_gasto: porTipoGasto.map((row) => ({
        expense_type: row.expense_type ?? 'sin_clasificar',
        count: row.count,
        monto: toNumber(row.monto) ?? 0,
      })),
      top_proveedores: topProveedores.map((row) => ({
        proveedor: row.proveedor,
        count: row.count,
        monto: toNumber(row.monto) ?? 0,
      })),
      generated_at: new Date().toISOString(),
    };
  }

  // ── Aprobaciones / Entregas / Comité: fórmulas EXISTENTES (regla 3) ─────

  async getAprobaciones() {
    return {
      // ApprovalsService.getStats() es acumulado; se consume sin variantes
      fuente: 'approvals/stats (fórmula existente, acumulado)',
      stats: await this.approvalsService.getStats(),
      generated_at: new Date().toISOString(),
    };
  }

  async getEntregas() {
    const [stats, porProveedor] = await Promise.all([
      this.expeditingService.getStats(),
      // Misma fórmula que suppliers.service (entregada_completa y
      // actual <= expected sobre la fecha ORIGINAL de la PO) — réplica
      // documentada, por proveedor y en SQL
      this.prisma.$queryRaw<
        Array<{
          proveedor: string;
          entregadas: number;
          a_tiempo: number;
        }>
      >(Prisma.sql`
        SELECT s.legal_name AS proveedor,
               count(*)::int AS entregadas,
               count(*) FILTER (
                 WHERE po.actual_delivery_date IS NOT NULL
                   AND po.expected_delivery_date IS NOT NULL
                   AND po.actual_delivery_date <= po.expected_delivery_date
               )::int AS a_tiempo
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.is_active = true AND po.status = 'entregada_completa'
        GROUP BY s.legal_name
        ORDER BY entregadas DESC LIMIT 10`),
    ]);
    return {
      fuente: 'expediting/stats (fórmula existente, acumulado)',
      stats,
      on_time_por_proveedor: porProveedor.map((row) => ({
        proveedor: row.proveedor,
        entregadas: row.entregadas,
        a_tiempo: row.a_tiempo,
        rate:
          row.entregadas > 0
            ? Math.round((row.a_tiempo / row.entregadas) * 100)
            : 0,
      })),
      generated_at: new Date().toISOString(),
    };
  }

  async getComite() {
    return {
      fuente: 'comite dashboard/tiempos (fórmula existente de §16, acumulado)',
      tiempos: await this.committeesService.dashboardTiempos(),
      generated_at: new Date().toISOString(),
    };
  }

  // ── Contratos ───────────────────────────────────────────────────────────

  /**
   * I6 (2026-09-30): valor de los contratos vigentes POR MONEDA. Antes se
   * sumaba todo (y el resumen lo mostraba como MXN); la base real de Diana
   * trae contratos en USD y EUR.
   */
  private async vigentesPorMoneda(): Promise<
    Array<{ currency: string; total: number }>
  > {
    const groups = await this.prisma.contracts.groupBy({
      by: ['currency'],
      where: {
        is_active: true,
        status: 'vigente',
        total_amount: { not: null },
      },
      _sum: { total_amount: true },
    });
    const rank = (c: string) => (c === 'MXN' ? 0 : c === 'USD' ? 1 : 2);
    return groups
      .map((g) => ({
        currency: g.currency ?? 'Sin moneda',
        total: toNumber(g._sum.total_amount) ?? 0,
      }))
      .sort(
        (a, b) =>
          rank(a.currency) - rank(b.currency) ||
          a.currency.localeCompare(b.currency),
      );
  }

  async getContratos() {
    const today = new Date();
    const [porVencer, vigentes, vigentesPorMoneda, consumo] = await Promise.all(
      [
        this.prisma.contracts.findMany({
          where: {
            is_active: true,
            status: 'vigente',
            end_date: {
              gte: today,
              lte: new Date(today.getTime() + 30 * 86_400_000),
            },
          },
          select: {
            id: true,
            contract_number: true,
            end_date: true,
            total_amount: true,
            suppliers: { select: { legal_name: true } },
          },
          orderBy: { end_date: 'asc' },
          take: 10,
        }),
        this.prisma.contracts.count({
          where: { is_active: true, status: 'vigente' },
        }),
        this.vigentesPorMoneda(),
        // Consumo = POs vinculadas (contract_id, §15/A3) vs monto del contrato
        this.prisma.$queryRaw<Array<{ promedio_consumo_pct: unknown }>>(
          Prisma.sql`
        SELECT avg(least(consumido / total, 1)) * 100 AS promedio_consumo_pct
        FROM (
          SELECT c.total_amount AS total,
                 coalesce(sum(po.amount) FILTER (
                   WHERE po.is_active = true AND po.status <> 'cancelada'
                 ), 0) AS consumido
          FROM contracts c
          LEFT JOIN purchase_orders po ON po.contract_id = c.id
          WHERE c.is_active = true AND c.status = 'vigente'
            AND c.total_amount IS NOT NULL AND c.total_amount > 0
          GROUP BY c.id, c.total_amount
        ) t`,
        ),
      ],
    );

    return {
      por_vencer_30_dias: porVencer.map((contract) => ({
        id: contract.id,
        contract_number: contract.contract_number,
        proveedor: contract.suppliers.legal_name,
        end_date: contract.end_date,
        total_amount: toNumber(contract.total_amount),
      })),
      vigentes: {
        total: vigentes,
        // I6: montos por moneda, nunca sumados
        por_moneda: vigentesPorMoneda,
      },
      promedio_consumo_pct:
        toNumber(consumo[0]?.promedio_consumo_pct) === null
          ? null
          : Math.round(Number(consumo[0].promedio_consumo_pct) * 10) / 10,
      generated_at: new Date().toISOString(),
    };
  }

  // ── Maximo (staging, lectura; "sin clasificar" visible — regla 6) ──────

  async getMaximo(dto: ReportPeriodDto) {
    const period = this.resolvePeriod(dto);
    const [posPorEstatus, posPorMes, contratosPorEstatus] = await Promise.all([
      this.prisma.$queryRaw<Array<{ status: string; count: number }>>(
        Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT coalesce(status, 'sin_clasificar') AS status, count(*)::int AS count
        FROM current GROUP BY 1 ORDER BY count DESC`,
      ),
      this.prisma.$queryRaw<MonthCount[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT date_trunc('month', approved_at) AS month, count(*)::int AS count
        FROM current
        WHERE approved_at BETWEEN ${period.from} AND ${period.to}
        GROUP BY 1`),
      this.prisma.$queryRaw<Array<{ status: string; count: number }>>(
        Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_CONTRACTS})
        SELECT coalesce(status, 'sin_clasificar') AS status, count(*)::int AS count
        FROM current GROUP BY 1 ORDER BY count DESC`,
      ),
    ]);

    const sinFechaPos = await this.prisma.$queryRaw<Array<{ count: number }>>(
      Prisma.sql`
      WITH current AS (${CURRENT_MAXIMO_POS})
      SELECT count(*)::int AS count FROM current WHERE approved_at IS NULL`,
    );

    return {
      periodo: this.periodOut(period),
      purchase_orders: {
        por_estatus: posPorEstatus,
        serie_mensual_aprobadas: seriesFrom(period, posPorMes),
        sin_fecha_aprobacion: sinFechaPos[0]?.count ?? 0,
      },
      contracts: { por_estatus: contratosPorEstatus },
      generated_at: new Date().toISOString(),
    };
  }

  // ── SAP + Maximo por periodo (sprint 2026-09-22, B2) ────────────────────

  /**
   * Volumen, estatus y montos POR MONEDA de los dos ERPs en el periodo (SAP
   * por doc_date; Maximo OC por created_at_source y contratos por
   * start_date). Nada se suma entre monedas ni entre fuentes.
   */
  async getErp(dto: ReportPeriodDto) {
    const period = this.resolvePeriod(dto);
    type MonthAmount = {
      month: Date | null;
      currency: string | null;
      count: number;
      monto: unknown;
    };
    type StatusRow = { status: string | null; count: number };
    type SapVendorRow = {
      card_code: string | null;
      card_name: string | null;
      currency: string | null;
      count: number;
      monto: unknown;
    };
    type MaximoPoRow = {
      ponum: string;
      vendor_id: string | null;
      vendor_name: string | null;
      currency: string | null;
      total_cost: unknown;
    };
    const [
      sapPoSerie,
      sapPrSerie,
      sapPoStatus,
      sapPrStatus,
      sapVendors,
      maximoPoSerie,
      maximoPoStatus,
      maximoContractStatus,
      maximoPos,
      xref,
    ] = await Promise.all([
      this.prisma.$queryRaw<MonthAmount[]>(Prisma.sql`
        SELECT date_trunc('month', doc_date) AS month, currency, count(*)::int AS count,
               coalesce(sum(doc_total), 0) AS monto
        FROM sap_purchase_orders
        WHERE cancelled IS DISTINCT FROM true
          AND doc_date BETWEEN ${period.from} AND ${period.to}
          ${andSapPoCountedOnce('sap_purchase_orders')}
        GROUP BY 1, 2 ORDER BY 1`),
      this.prisma.$queryRaw<MonthAmount[]>(Prisma.sql`
        SELECT date_trunc('month', doc_date) AS month, currency, count(*)::int AS count,
               coalesce(sum(doc_total), 0) AS monto
        FROM sap_purchase_requests
        WHERE cancelled IS DISTINCT FROM true
          AND doc_date BETWEEN ${period.from} AND ${period.to}
        GROUP BY 1, 2 ORDER BY 1`),
      this.prisma.$queryRaw<StatusRow[]>(Prisma.sql`
        SELECT CASE WHEN cancelled = true THEN 'cancelled'
                    WHEN document_status = 'bost_Open' THEN 'open'
                    WHEN document_status = 'bost_Close' THEN 'close'
                    ELSE coalesce(document_status, 'sin_estatus') END AS status,
               count(*)::int AS count
        FROM sap_purchase_orders
        WHERE doc_date BETWEEN ${period.from} AND ${period.to}
        GROUP BY 1 ORDER BY count DESC`),
      this.prisma.$queryRaw<StatusRow[]>(Prisma.sql`
        SELECT CASE WHEN cancelled = true THEN 'cancelled'
                    WHEN document_status = 'bost_Open' THEN 'open'
                    WHEN document_status = 'bost_Close' THEN 'close'
                    ELSE coalesce(document_status, 'sin_estatus') END AS status,
               count(*)::int AS count
        FROM sap_purchase_requests
        WHERE doc_date BETWEEN ${period.from} AND ${period.to}
        GROUP BY 1 ORDER BY count DESC`),
      // G1: por código (las variantes de nombre se juntan) con el nombre del
      // maestro de SAP; sin LIMIT porque también alimenta el top combinado
      this.prisma.$queryRaw<SapVendorRow[]>(Prisma.sql`
        SELECT t.card_code, coalesce(bp.card_name, t.card_name) AS card_name,
               t.currency, t.count, t.monto
        FROM (
          SELECT card_code, mode() WITHIN GROUP (ORDER BY card_name) AS card_name,
                 currency, count(*)::int AS count,
                 coalesce(sum(doc_total), 0) AS monto
          FROM sap_purchase_orders
          WHERE cancelled IS DISTINCT FROM true
            AND doc_date BETWEEN ${period.from} AND ${period.to}
            ${andSapPoCountedOnce('sap_purchase_orders')}
          GROUP BY card_code, currency
        ) t
        LEFT JOIN sap_business_partners bp ON bp.card_code = t.card_code`),
      this.prisma.$queryRaw<MonthAmount[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT date_trunc('month', created_at_source) AS month, currency, count(*)::int AS count,
               coalesce(sum(total_cost), 0) AS monto
        FROM current
        WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL')
          AND created_at_source BETWEEN ${period.from} AND ${period.to}
        GROUP BY 1, 2 ORDER BY 1`),
      this.prisma.$queryRaw<StatusRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT coalesce(status, 'sin_estatus') AS status, count(*)::int AS count
        FROM current
        WHERE created_at_source IS NULL
           OR created_at_source BETWEEN ${period.from} AND ${period.to}
        GROUP BY 1 ORDER BY count DESC`),
      this.prisma.$queryRaw<StatusRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_CONTRACTS})
        SELECT coalesce(status, 'sin_estatus') AS status, count(*)::int AS count
        FROM current
        WHERE start_date IS NULL OR start_date BETWEEN ${period.from} AND ${period.to}
        GROUP BY 1 ORDER BY count DESC`),
      // G1: OC del periodo; el proveedor efectivo se resuelve en memoria
      this.prisma.$queryRaw<MaximoPoRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT ponum, vendor_id, vendor_name, currency, total_cost
        FROM current
        WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL')
          AND created_at_source BETWEEN ${period.from} AND ${period.to}`),
      this.vendors.get(),
    ]);

    // Serie mensual por moneda, zero-filled dentro del periodo.
    const serie = (rows: MonthAmount[]) => {
      const currencies = Array.from(
        new Set(rows.map((r) => r.currency ?? 'sin_moneda')),
      );
      const months = zeroFilledMonths(period);
      const index = new Map<string, { count: number; monto: number }>();
      for (const r of rows) {
        if (!r.month) continue;
        index.set(`${monthKey(r.month)}|${r.currency ?? 'sin_moneda'}`, {
          count: Number(r.count),
          monto: toNumber(r.monto) ?? 0,
        });
      }
      return {
        monedas: currencies,
        meses: months.map((month) => ({
          month,
          count: currencies.reduce(
            (sum, c) => sum + (index.get(`${month}|${c}`)?.count ?? 0),
            0,
          ),
          por_moneda: currencies.map((currency) => ({
            currency,
            count: index.get(`${month}|${currency}`)?.count ?? 0,
            monto: index.get(`${month}|${currency}`)?.monto ?? 0,
          })),
        })),
      };
    };
    const sapAmounts: VendorAmount[] = sapVendors.map((r) => ({
      key: `sap:${r.card_code ?? '(sin código)'}`,
      code: r.card_code,
      name: r.card_name,
      currency: r.currency,
      count: Number(r.count),
      monto: toNumber(r.monto) ?? 0,
      source: 'sap',
    }));
    const maximoAmounts = maximoVendorAmounts(maximoPos, xref);

    return {
      periodo: this.periodOut(period),
      sap: {
        ordenes: { serie_mensual: serie(sapPoSerie), por_estatus: sapPoStatus },
        solicitudes: {
          serie_mensual: serie(sapPrSerie),
          por_estatus: sapPrStatus,
        },
        top_proveedores: rankVendors(sapAmounts, new Map()),
      },
      maximo: {
        ordenes: {
          serie_mensual: serie(maximoPoSerie),
          por_estatus: maximoPoStatus,
        },
        contratos: { por_estatus: maximoContractStatus },
        // G1: por proveedor efectivo (según SAP si la OC migró o por cruce)
        top_proveedores: rankVendors(maximoAmounts, xref.bpNames),
      },
      // G1: SAP + Maximo contado una vez (D1), por proveedor efectivo
      combinado: {
        top_proveedores: rankVendors(
          [...sapAmounts, ...maximoAmounts],
          xref.bpNames,
        ),
      },
      generated_at: new Date().toISOString(),
    };
  }

  // ── Tiempos de aprobación SAP + Maximo (sprint 2026-09-22, B3) ──────────

  /**
   * Maximo: OC = approved_at − waiting_approval_at (primer WAPPR; fallback
   * created_at_source); contratos = approved_at − created_at_source. SAP:
   * desde la cola de autorización (B5): solicitudes aprobadas = fecha de la
   * última decisión − creación. null = sin base (nunca 0).
   *
   * G5/G6 (2026-09-28): por aprobador = días desde que el documento LE LLEGÓ
   * (ver approver-stats.ts), acumulado. Maximo por cada aprobación del
   * historial POSTATUS (todos los niveles: aparecen Miguel y Gilberto); SAP
   * por línea de la cola; pendientes de SAP con la antigüedad desde que le
   * llegó. El histórico con periodo vive en /compras/reportes/aprobadores.
   */
  async getTiemposAprobacion() {
    type AvgRow = { dias: unknown; total: number };
    type PendingRow = {
      total: number;
      dias_max: number | null;
      dias_promedio: unknown;
    };
    type GestionPoRow = {
      doc_entry: number;
      doc_date: Date | null;
      base_request_entries: number[];
    };
    const [
      maximoPo,
      maximoApprovals,
      maximoContracts,
      sapAll,
      sapPending,
      maximoPending,
      abentRoles,
      gestionPos,
      sapDocs,
    ] = await Promise.all([
      this.prisma.$queryRaw<AvgRow[]>(Prisma.sql`
          WITH current AS (${CURRENT_MAXIMO_POS})
          SELECT avg(extract(epoch FROM (approved_at - coalesce(waiting_approval_at, created_at_source))) / 86400) AS dias,
                 count(*)::int AS total
          FROM current
          WHERE approved_at IS NOT NULL
            AND coalesce(waiting_approval_at, created_at_source) IS NOT NULL
            AND approved_at >= coalesce(waiting_approval_at, created_at_source)`),
      // G6: todas las aprobaciones del historial POSTATUS (todos los niveles)
      loadMaximoApprovals(this.prisma),
      this.prisma.$queryRaw<AvgRow[]>(Prisma.sql`
          WITH current AS (${CURRENT_MAXIMO_CONTRACTS})
          SELECT avg(extract(epoch FROM (approved_at - created_at_source)) / 86400) AS dias,
                 count(*)::int AS total
          FROM current
          WHERE approved_at IS NOT NULL AND created_at_source IS NOT NULL
            AND approved_at >= created_at_source`),
      this.prisma.$queryRaw<AvgRow[]>(Prisma.sql`
          SELECT avg(extract(epoch FROM (d.decided_at - r.creation_date)) / 86400) AS dias,
                 count(*)::int AS total
          FROM sap_approval_requests r
          JOIN LATERAL (
            SELECT max((a->>'update_date')::timestamptz) AS decided_at
            FROM jsonb_array_elements(coalesce(r.approvers, '[]'::jsonb)) a
            WHERE a->>'status' = 'ardApproved'
          ) d ON true
          WHERE r.status = 'arsApproved' AND r.creation_date IS NOT NULL
            AND d.decided_at IS NOT NULL AND d.decided_at >= r.creation_date`),
      this.prisma.$queryRaw<Array<{ total: number; dias: unknown }>>(Prisma.sql`
          SELECT count(*)::int AS total,
                 avg(extract(epoch FROM (now() - creation_date)) / 86400) AS dias
          FROM sap_approval_requests WHERE status = 'arsPending'`),
      // Maximo solo registra al aprobador al aprobar: de las OC en espera se
      // sabe cuántas y desde cuándo, no quién las tiene. G7: en aprobación =
      // WAPPR, APPRn y APPRnREV; G6: antigüedad desde su último cambio.
      this.prisma.$queryRaw<PendingRow[]>(Prisma.sql`
          WITH current AS (${CURRENT_MAXIMO_POS}),
          pend AS (
            SELECT ${maximoStatusSince('c')} AS desde
            FROM current c WHERE ${maximoInApproval('c')}
          )
          SELECT count(*)::int AS total,
                 max(current_date - desde::date)::int AS dias_max,
                 avg(current_date - desde::date) AS dias_promedio
          FROM pend`),
      this.prisma.user_roles.findMany({
        where: {
          is_active: true,
          module: 'compras',
          role: { in: ABENT_LEVEL_ROLES.map((l) => l.role) },
          profiles_user_roles_profile_idToprofiles: { is_active: true },
        },
        select: {
          role: true,
          profiles_user_roles_profile_idToprofiles: {
            select: { id: true, full_name: true, email: true },
          },
        },
      }),
      // D3: OC de SAP con solicitud base (gestión = OC − solicitud)
      this.prisma.$queryRaw<GestionPoRow[]>(Prisma.sql`
          SELECT doc_entry, doc_date, base_request_entries
          FROM sap_purchase_orders
          WHERE cancelled IS DISTINCT FROM true
            AND cardinality(base_request_entries) > 0`),
      // G5: cola de autorización con sus líneas por etapa
      loadSapApprovalDocs(this.prisma),
    ]);
    const requestEntries = [
      ...new Set(gestionPos.flatMap((po) => po.base_request_entries)),
    ];
    const gestionPrs =
      requestEntries.length === 0
        ? []
        : await this.prisma.$queryRaw<
            Array<{ doc_entry: number; doc_date: Date | null }>
          >(Prisma.sql`
            SELECT doc_entry, doc_date FROM sap_purchase_requests
            WHERE doc_entry IN (${Prisma.join(requestEntries)})`);
    const gestionOc = sapGestionDays(gestionPos, gestionPrs);

    // G5/G6: por aprobador, días desde que le llegó (acumulado)
    const allTime = { from: new Date(0), to: new Date(8.64e15) };
    const sapByUser = summarizeApprovers(
      sapApproverEvents(sapDocs, new Date()),
      allTime,
      { withPending: true, withRejected: true },
    );
    const maximoByUser = summarizeApprovers(
      maximoApproverEvents(maximoApprovals),
      allTime,
      { withPending: false, withRejected: false },
    );
    const topApproved = <T extends { aprobadas: { total: number } }>(
      rows: T[],
    ) =>
      rows
        .filter((r) => r.aprobadas.total > 0)
        .sort((a, b) => b.aprobadas.total - a.aprobadas.total)
        .slice(0, 15);

    // D6: alias de usuarios (Maximo: CHANGEBY; SAP: user_name de la cola)
    const [maximoNames, sapNames, levelAliases] = await Promise.all([
      this.aliases.resolveMany(
        'maximo',
        maximoByUser.map((r) => r.usuario),
      ),
      this.aliases.resolveMany(
        'sap',
        sapByUser.map((r) => r.usuario),
      ),
      this.aliases.forProfiles(
        abentRoles.map((r) => r.profiles_user_roles_profile_idToprofiles.id),
      ),
    ]);
    const named = (system: 'sap' | 'maximo', code: string | null) =>
      code === null
        ? null
        : ((system === 'sap' ? sapNames : maximoNames).get(code) ?? code);
    const avg = (rows: AvgRow[]) => {
      const v = toNumber(rows[0]?.dias);
      return {
        promedio_dias: v === null ? null : Math.round(v * 10) / 10,
        total: Number(rows[0]?.total ?? 0),
      };
    };
    const sapPendingBy = sapByUser
      .filter((r) => (r.pendientes?.total ?? 0) > 0)
      .map((r) => ({
        aprobador: named('sap', r.usuario) ?? r.usuario,
        usuario: r.usuario,
        pendientes: r.pendientes?.total ?? 0,
        // días completos con el aprobador
        dias_esperando_max:
          r.pendientes?.dias_max === null || r.pendientes === null
            ? null
            : Math.floor(r.pendientes.dias_max),
        dias_esperando_promedio: r.pendientes?.dias_promedio ?? null,
      }))
      .sort(
        (a, b) =>
          (b.dias_esperando_max ?? -1) - (a.dias_esperando_max ?? -1) ||
          b.pendientes - a.pendientes,
      );
    return {
      maximo: {
        ordenes: avg(maximoPo),
        // G6: por cada aprobación del historial (todos los niveles)
        ordenes_por_aprobador: topApproved(maximoByUser).map((r) => ({
          aprobador: named('maximo', r.usuario) ?? r.usuario,
          usuario: r.usuario,
          promedio_dias: r.aprobadas.dias_promedio ?? 0,
          total: r.aprobadas.total,
          niveles: r.niveles ?? [],
        })),
        contratos: avg(maximoContracts),
      },
      sap: {
        // D3: gestión de OC = fecha de la OC − fecha de su solicitud de pedido
        gestion_oc: {
          promedio_dias: gestionOc.promedio_dias,
          total: gestionOc.total,
          descartadas: gestionOc.descartadas,
          definicion:
            'De la fecha de la solicitud de pedido (la más antigua) a la fecha de la OC; solo OC con solicitud de pedido en SAP',
        },
        solicitudes_autorizadas: avg(sapAll),
        // G5: días desde que le llegó (última decisión de otra etapa)
        por_aprobador: topApproved(sapByUser).map((r) => ({
          aprobador: named('sap', r.usuario) ?? r.usuario,
          usuario: r.usuario,
          promedio_dias: r.aprobadas.dias_promedio ?? 0,
          total: r.aprobadas.total,
        })),
        pendientes: {
          total: Number(sapPending[0]?.total ?? 0),
          dias_esperando_promedio:
            toNumber(sapPending[0]?.dias) === null
              ? null
              : Math.round(Number(sapPending[0]?.dias) * 10) / 10,
        },
        pendientes_por_aprobador: sapPendingBy,
      },
      maximo_pendientes: {
        total: Number(maximoPending[0]?.total ?? 0),
        dias_esperando_max:
          maximoPending[0]?.dias_max === null ||
          maximoPending[0]?.dias_max === undefined
            ? null
            : Number(maximoPending[0].dias_max),
        dias_esperando_promedio: roundDays(maximoPending[0]?.dias_promedio),
      },
      // Flujo propio: quién tiene asignado cada nivel en el sistema (rol de
      // compras activo). Nivel sin nadie = aprobador aún no asignado.
      // D6: si el perfil está ligado a un usuario de SAP/Maximo, se muestran
      // sus usuarios del ERP y sus autorizaciones pendientes en SAP.
      abent_niveles: ABENT_LEVEL_ROLES.map(({ level, role }) => {
        const profiles = abentRoles
          .filter((r) => r.role === role)
          .map((r) => r.profiles_user_roles_profile_idToprofiles);
        const ids = new Set(profiles.map((p) => p.id));
        const erpUsuarios = levelAliases
          .filter((a) => a.profile_id !== null && ids.has(a.profile_id))
          .map((a) => ({ system: a.system, code: a.code }));
        const sapCodes = new Set(
          erpUsuarios
            .filter((a) => a.system === 'sap')
            .map((a) => a.code.trim().toLowerCase()),
        );
        const sapPendientes = sapPendingBy
          .filter((r) => sapCodes.has(r.usuario.trim().toLowerCase()))
          .reduce((sum, r) => sum + r.pendientes, 0);
        return {
          level,
          role,
          aprobadores: profiles.map((p) => p.full_name || p.email),
          erp_usuarios: erpUsuarios,
          sap_pendientes: sapPendientes,
        };
      }),
      generated_at: new Date().toISOString(),
    };
  }

  // ── Ahorro por FUENTE (T10: nunca sumado entre fuentes) ────────────────

  async getAhorro(dto: ReportPeriodDto) {
    const period = this.resolvePeriod(dto);
    const porMoneda = await this.prisma.$queryRaw<
      Array<{ currency: string | null; total: unknown; count: number }>
    >(Prisma.sql`
      WITH current AS (${CURRENT_MAXIMO_POS})
      SELECT currency, coalesce(sum(ab_ahorro), 0) AS total, count(*)::int AS count
      FROM current
      WHERE ab_ahorro IS NOT NULL
        AND (approved_at IS NULL OR approved_at BETWEEN ${period.from} AND ${period.to})
      GROUP BY currency ORDER BY total DESC`);
    const sinClasificar = await this.prisma.$queryRaw<
      Array<{ count: number }>
    >(Prisma.sql`
      WITH current AS (${CURRENT_MAXIMO_POS})
      SELECT count(*)::int AS count FROM current WHERE ab_ahorro IS NULL`);

    const sap = await this.prisma.$queryRaw<
      Array<{
        currency: string | null;
        total: unknown;
        docs: number;
        lines_total: number;
        lines_classified: number;
      }>
    >(Prisma.sql`
      SELECT currency, coalesce(sum(ahorro_total), 0) AS total,
             count(*) FILTER (WHERE ahorro_total IS NOT NULL)::int AS docs,
             coalesce(sum(lines_total), 0)::int AS lines_total,
             coalesce(sum(lines_classified), 0)::int AS lines_classified
      FROM sap_purchase_orders
      WHERE cancelled IS DISTINCT FROM true
        AND doc_date BETWEEN ${period.from} AND ${period.to}
      GROUP BY currency ORDER BY total DESC`);

    return {
      periodo: this.periodOut(period),
      // T10: fuentes separadas, NO sumables entre sí (ni entre monedas)
      sap: {
        // T10: sin documentos con ahorro capturado el total es null, no 0
        por_moneda: sap.map((row) => ({
          currency: row.currency ?? 'sin_moneda',
          total: Number(row.docs) === 0 ? null : (toNumber(row.total) ?? 0),
          documentos_con_ahorro: Number(row.docs),
        })),
        lineas_total: sap.reduce((s, r) => s + Number(r.lines_total), 0),
        lineas_clasificadas: sap.reduce(
          (s, r) => s + Number(r.lines_classified),
          0,
        ),
        nota: 'Captura de U_Imp_ahorro en marcha desde 2026-09-15 (incremental)',
      },
      abent: {
        disponible: false,
        motivo:
          'El modelo propio (requisitions/purchase_orders) no tiene campo de ahorro; pendiente de definir con Ingrid/Omar',
      },
      maximo: {
        por_moneda: porMoneda.map((row) => ({
          currency: row.currency ?? 'sin_moneda',
          total: toNumber(row.total) ?? 0,
          registros: row.count,
        })),
        sin_clasificar: sinClasificar[0]?.count ?? 0,
      },
      generated_at: new Date().toISOString(),
    };
  }
}
