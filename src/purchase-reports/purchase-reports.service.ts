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

    return {
      periodo: this.periodOut(period),
      // T10: fuentes separadas, NO sumables entre sí (ni entre monedas)
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
