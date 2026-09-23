import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ExpeditingService } from '../expediting/expediting.service';
import { PurchaseCommitteesService } from '../purchase-committees/purchase-committees.service';
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
const CURRENT_MAXIMO_POS = Prisma.sql`
  SELECT DISTINCT ON (ponum, coalesce(siteid, '')) *
  FROM maximo_purchase_orders
  ORDER BY ponum, coalesce(siteid, ''), coalesce(revisionnum, 0) DESC`;

const CURRENT_MAXIMO_CONTRACTS = Prisma.sql`
  SELECT DISTINCT ON (coalesce(prnum, ''), coalesce(contractnum, '')) *
  FROM maximo_contracts
  ORDER BY coalesce(prnum, ''), coalesce(contractnum, ''),
    coalesce(revisionnum, 0) DESC`;

function toNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

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
  ) {}

  /** Default: últimos 12 meses. Tope: 24 (regla 5). */
  resolvePeriod(dto: ReportPeriodDto): ReportPeriod {
    const to = dto.to ? new Date(dto.to) : new Date();
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
      this.prisma.contracts.aggregate({
        where: { is_active: true, status: 'vigente' },
        _sum: { total_amount: true },
      }),
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
        solicitudes: {
          creadas: erp.sap.rq_creadas + erp.maximo.rq_creadas + rqsCreadas,
          abiertas: erp.sap.rq_abiertas + erp.maximo.rq_abiertas + rqsAbiertas,
          por_fuente: {
            sap: { creadas: erp.sap.rq_creadas, abiertas: erp.sap.rq_abiertas },
            maximo: {
              creadas: erp.maximo.rq_creadas,
              abiertas: erp.maximo.rq_abiertas,
            },
            abent: { creadas: rqsCreadas, abiertas: rqsAbiertas },
          },
        },
        dias_gestion: {
          sap: erp.sap.dias,
          maximo: erp.maximo.dias,
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
        valor_vigentes: toNumber(valorVigentes._sum.total_amount) ?? 0,
      },
      proveedores: { bloqueados: proveedoresBloqueados },
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Parte ERP del resumen: solicitudes (SAP por doc_date, Maximo PR por
   * created_at_source), días de gestión (misma definición que el dashboard),
   * OC por moneda y contratos de Maximo que vencen en 30 días.
   */
  private async resumenErp(period: ReportPeriod) {
    type CountsRow = {
      sap_rq_creadas: number;
      sap_rq_abiertas: number;
      sap_dias: unknown;
      maximo_rq_creadas: number;
      maximo_rq_abiertas: number;
      maximo_dias: unknown;
      maximo_contratos_por_vencer: number;
    };
    type MontoRow = {
      fuente: 'sap' | 'maximo';
      currency: string | null;
      count: number;
      total: unknown;
    };
    const [counts, montos] = await Promise.all([
      this.prisma.$queryRaw<CountsRow[]>(Prisma.sql`
        WITH current_contracts AS (${CURRENT_MAXIMO_CONTRACTS})
        SELECT
          (SELECT count(*) FROM sap_purchase_requests
            WHERE cancelled IS DISTINCT FROM true
              AND doc_date BETWEEN ${period.from} AND ${period.to})::int AS sap_rq_creadas,
          (SELECT count(*) FROM sap_purchase_requests
            WHERE document_status = 'bost_Open' AND cancelled IS DISTINCT FROM true)::int AS sap_rq_abiertas,
          (SELECT avg(extract(epoch FROM (coalesce(closing_date, update_date_source) - doc_date)) / 86400)
             FROM sap_purchase_requests
            WHERE document_status = 'bost_Close' AND cancelled IS DISTINCT FROM true
              AND doc_date BETWEEN ${period.from} AND ${period.to}
              AND coalesce(closing_date, update_date_source) >= doc_date) AS sap_dias,
          (SELECT count(*) FROM current_contracts
            WHERE prnum IS NOT NULL
              AND created_at_source BETWEEN ${period.from} AND ${period.to})::int AS maximo_rq_creadas,
          (SELECT count(*) FROM current_contracts
            WHERE prnum IS NOT NULL AND status IN ('WAPPR', 'PNDREV'))::int AS maximo_rq_abiertas,
          (SELECT avg(extract(epoch FROM (approved_at - created_at_source)) / 86400)
             FROM current_contracts
            WHERE prnum IS NOT NULL AND created_at_source IS NOT NULL
              AND approved_at BETWEEN ${period.from} AND ${period.to}
              AND approved_at >= created_at_source) AS maximo_dias,
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
        GROUP BY currency
        UNION ALL
        SELECT 'maximo' AS fuente, currency, count(*)::int AS count,
               coalesce(sum(total_cost), 0) AS total
        FROM (${CURRENT_MAXIMO_POS}) current
        WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL')
          AND created_at_source BETWEEN ${period.from} AND ${period.to}
        GROUP BY currency`),
    ]);
    const row = counts[0];
    const ocDe = (fuente: MontoRow['fuente']) =>
      montos
        .filter((m) => m.fuente === fuente)
        .reduce((sum, m) => sum + Number(m.count), 0);
    return {
      sap: {
        rq_creadas: Number(row?.sap_rq_creadas ?? 0),
        rq_abiertas: Number(row?.sap_rq_abiertas ?? 0),
        dias: roundDays(row?.sap_dias),
        oc: ocDe('sap'),
      },
      maximo: {
        rq_creadas: Number(row?.maximo_rq_creadas ?? 0),
        rq_abiertas: Number(row?.maximo_rq_abiertas ?? 0),
        dias: roundDays(row?.maximo_dias),
        oc: ocDe('maximo'),
        contratos_por_vencer: Number(row?.maximo_contratos_por_vencer ?? 0),
      },
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

  async getContratos() {
    const today = new Date();
    const [porVencer, vigentes, consumo] = await Promise.all([
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
      this.prisma.contracts.aggregate({
        where: { is_active: true, status: 'vigente' },
        _count: { _all: true },
        _sum: { total_amount: true },
      }),
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
    ]);

    return {
      por_vencer_30_dias: porVencer.map((contract) => ({
        id: contract.id,
        contract_number: contract.contract_number,
        proveedor: contract.suppliers.legal_name,
        end_date: contract.end_date,
        total_amount: toNumber(contract.total_amount),
      })),
      vigentes: {
        total: vigentes._count._all,
        valor_total: toNumber(vigentes._sum.total_amount) ?? 0,
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
    type VendorRow = {
      proveedor: string | null;
      currency: string | null;
      count: number;
      monto: unknown;
    };
    const [
      sapPoSerie,
      sapPrSerie,
      sapPoStatus,
      sapPrStatus,
      sapTop,
      maximoPoSerie,
      maximoPoStatus,
      maximoContractStatus,
      maximoTop,
    ] = await Promise.all([
      this.prisma.$queryRaw<MonthAmount[]>(Prisma.sql`
        SELECT date_trunc('month', doc_date) AS month, currency, count(*)::int AS count,
               coalesce(sum(doc_total), 0) AS monto
        FROM sap_purchase_orders
        WHERE cancelled IS DISTINCT FROM true
          AND doc_date BETWEEN ${period.from} AND ${period.to}
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
      this.prisma.$queryRaw<VendorRow[]>(Prisma.sql`
        SELECT card_name AS proveedor, currency, count(*)::int AS count,
               coalesce(sum(doc_total), 0) AS monto
        FROM sap_purchase_orders
        WHERE cancelled IS DISTINCT FROM true
          AND doc_date BETWEEN ${period.from} AND ${period.to}
        GROUP BY card_name, currency ORDER BY monto DESC LIMIT 10`),
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
      this.prisma.$queryRaw<VendorRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT vendor_name AS proveedor, currency, count(*)::int AS count,
               coalesce(sum(total_cost), 0) AS monto
        FROM current
        WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL') AND vendor_name IS NOT NULL
          AND created_at_source BETWEEN ${period.from} AND ${period.to}
        GROUP BY vendor_name, currency ORDER BY monto DESC LIMIT 10`),
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
    const vendors = (rows: VendorRow[]) =>
      rows.map((r) => ({
        proveedor: r.proveedor ?? 'Sin proveedor',
        currency: r.currency,
        count: Number(r.count),
        monto: toNumber(r.monto) ?? 0,
      }));

    return {
      periodo: this.periodOut(period),
      sap: {
        ordenes: { serie_mensual: serie(sapPoSerie), por_estatus: sapPoStatus },
        solicitudes: {
          serie_mensual: serie(sapPrSerie),
          por_estatus: sapPrStatus,
        },
        top_proveedores: vendors(sapTop),
      },
      maximo: {
        ordenes: {
          serie_mensual: serie(maximoPoSerie),
          por_estatus: maximoPoStatus,
        },
        contratos: { por_estatus: maximoContractStatus },
        top_proveedores: vendors(maximoTop),
      },
      generated_at: new Date().toISOString(),
    };
  }

  // ── Tiempos de aprobación SAP + Maximo (sprint 2026-09-22, B3) ──────────

  /**
   * Maximo: OC = approved_at − waiting_approval_at (primer WAPPR; fallback
   * created_at_source), por aprobador = CHANGEBY del primer APPR; contratos
   * = approved_at − created_at_source. SAP: desde la cola de autorización
   * (B5): solicitudes aprobadas = fecha de la última decisión − creación; por
   * aprobador = líneas ardApproved. null = sin base (nunca 0).
   */
  async getTiemposAprobacion() {
    type AvgRow = { dias: unknown; total: number };
    type ByRow = { aprobador: string | null; dias: unknown; total: number };
    type PendingByRow = {
      aprobador: string | null;
      pendientes: number;
      dias_max: number | null;
      dias_promedio: unknown;
    };
    type PendingRow = {
      total: number;
      dias_max: number | null;
      dias_promedio: unknown;
    };
    const [
      maximoPo,
      maximoPoBy,
      maximoContracts,
      sapAll,
      sapBy,
      sapPending,
      sapPendingBy,
      maximoPending,
      abentRoles,
    ] = await Promise.all([
      this.prisma.$queryRaw<AvgRow[]>(Prisma.sql`
          WITH current AS (${CURRENT_MAXIMO_POS})
          SELECT avg(extract(epoch FROM (approved_at - coalesce(waiting_approval_at, created_at_source))) / 86400) AS dias,
                 count(*)::int AS total
          FROM current
          WHERE approved_at IS NOT NULL
            AND coalesce(waiting_approval_at, created_at_source) IS NOT NULL
            AND approved_at >= coalesce(waiting_approval_at, created_at_source)`),
      this.prisma.$queryRaw<ByRow[]>(Prisma.sql`
          WITH current AS (${CURRENT_MAXIMO_POS})
          SELECT approved_by AS aprobador,
                 avg(extract(epoch FROM (approved_at - coalesce(waiting_approval_at, created_at_source))) / 86400) AS dias,
                 count(*)::int AS total
          FROM current
          WHERE approved_at IS NOT NULL AND approved_by IS NOT NULL
            AND coalesce(waiting_approval_at, created_at_source) IS NOT NULL
            AND approved_at >= coalesce(waiting_approval_at, created_at_source)
          GROUP BY approved_by ORDER BY total DESC LIMIT 15`),
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
      this.prisma.$queryRaw<ByRow[]>(Prisma.sql`
          SELECT a->>'user_name' AS aprobador,
                 avg(extract(epoch FROM ((a->>'update_date')::timestamptz - r.creation_date)) / 86400) AS dias,
                 count(*)::int AS total
          FROM sap_approval_requests r,
               jsonb_array_elements(coalesce(r.approvers, '[]'::jsonb)) a
          WHERE a->>'status' = 'ardApproved' AND r.creation_date IS NOT NULL
            AND (a->>'update_date') IS NOT NULL
            AND (a->>'update_date')::timestamptz >= r.creation_date
          GROUP BY 1 ORDER BY total DESC LIMIT 15`),
      this.prisma.$queryRaw<Array<{ total: number; dias: unknown }>>(Prisma.sql`
          SELECT count(*)::int AS total,
                 avg(extract(epoch FROM (now() - creation_date)) / 86400) AS dias
          FROM sap_approval_requests WHERE status = 'arsPending'`),
      // Quién tiene la pelota: aprobadores de la etapa actual con su línea
      // aún pendiente; días naturales desde que se creó la solicitud.
      this.prisma.$queryRaw<PendingByRow[]>(Prisma.sql`
          SELECT a->>'user_name' AS aprobador,
                 count(*)::int AS pendientes,
                 max(current_date - r.creation_date::date)::int AS dias_max,
                 avg(current_date - r.creation_date::date) AS dias_promedio
          FROM sap_approval_requests r,
               jsonb_array_elements(coalesce(r.approvers, '[]'::jsonb)) a
          WHERE r.status = 'arsPending' AND a->>'status' = 'ardPending'
            AND r.creation_date IS NOT NULL
            AND (r.current_stage IS NULL OR a->>'stage_code' IS NULL
                 OR (a->>'stage_code')::int = r.current_stage)
          GROUP BY 1 ORDER BY dias_max DESC, pendientes DESC`),
      // Maximo solo registra al aprobador al aprobar: de las OC en espera se
      // sabe cuántas y desde cuándo, no quién las tiene.
      this.prisma.$queryRaw<PendingRow[]>(Prisma.sql`
          WITH current AS (${CURRENT_MAXIMO_POS})
          SELECT count(*)::int AS total,
                 max(current_date - coalesce(waiting_approval_at, created_at_source)::date)::int AS dias_max,
                 avg(current_date - coalesce(waiting_approval_at, created_at_source)::date) AS dias_promedio
          FROM current
          WHERE status = 'WAPPR'
            AND coalesce(waiting_approval_at, created_at_source) IS NOT NULL`),
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
            select: { full_name: true, email: true },
          },
        },
      }),
    ]);
    const avg = (rows: AvgRow[]) => {
      const v = toNumber(rows[0]?.dias);
      return {
        promedio_dias: v === null ? null : Math.round(v * 10) / 10,
        total: Number(rows[0]?.total ?? 0),
      };
    };
    const by = (rows: ByRow[]) =>
      rows.map((r) => ({
        aprobador: r.aprobador ?? 'Sin nombre',
        promedio_dias: Math.round((toNumber(r.dias) ?? 0) * 10) / 10,
        total: Number(r.total),
      }));
    return {
      maximo: {
        ordenes: avg(maximoPo),
        ordenes_por_aprobador: by(maximoPoBy),
        contratos: avg(maximoContracts),
      },
      sap: {
        solicitudes_autorizadas: avg(sapAll),
        por_aprobador: by(sapBy),
        pendientes: {
          total: Number(sapPending[0]?.total ?? 0),
          dias_esperando_promedio:
            toNumber(sapPending[0]?.dias) === null
              ? null
              : Math.round(Number(sapPending[0]?.dias) * 10) / 10,
        },
        pendientes_por_aprobador: sapPendingBy.map((r) => ({
          aprobador: r.aprobador ?? 'Sin nombre en SAP',
          pendientes: Number(r.pendientes),
          dias_esperando_max: r.dias_max === null ? null : Number(r.dias_max),
          dias_esperando_promedio: roundDays(r.dias_promedio),
        })),
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
      abent_niveles: ABENT_LEVEL_ROLES.map(({ level, role }) => ({
        level,
        role,
        aprobadores: abentRoles
          .filter((r) => r.role === role)
          .map(
            (r) =>
              r.profiles_user_roles_profile_idToprofiles.full_name ||
              r.profiles_user_roles_profile_idToprofiles.email,
          ),
      })),
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
