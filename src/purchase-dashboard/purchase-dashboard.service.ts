import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Sprint 2026-09-22 (A1) — Resumen agregado del dashboard de Compras.
 *
 * Ingrid veía "todo en ceros" porque las tarjetas leían solo las tablas
 * propias (vacías). Este endpoint agrega en SQL las TRES fuentes — SAP
 * (staging `sap_*`), Maximo (staging `maximo_*`, versiones vigentes) y las
 * tablas propias — sin copiar registros entre ellas.
 *
 * Reglas del sprint:
 *  - Montos SIEMPRE por moneda (nunca se suma MXN con USD).
 *  - Lo que no tiene base sale `null` (nunca 0): la UI pinta "No disponible".
 *  - Maximo: `DISTINCT ON` = vista actual (misma definición que Int-5).
 *
 * Definiciones (van también en los tooltips de las tarjetas):
 *  - Solicitudes pendientes: SAP PR abiertas no canceladas; Maximo PR (raíz
 *    de maximo_contracts) en WAPPR/PNDREV; propias en revisión/aprobación.
 *  - Días de gestión: SAP = closing_date (o update_date_source como proxy) −
 *    doc_date de las cerradas; Maximo = approved_at − waiting_approval_at
 *    (o created_at_source) de las OC aprobadas; propias = business_days.
 *  - Por recibir: SAP OC abiertas no canceladas; Maximo OC APPR/INPRG;
 *    propias emitida/en_transito (enum po_status real de la BD). SAP no
 *    reporta "tránsito".
 */

const CURRENT_MAXIMO_POS = Prisma.sql`
  SELECT DISTINCT ON (ponum, coalesce(siteid, '')) *
  FROM maximo_purchase_orders
  ORDER BY ponum, coalesce(siteid, ''), coalesce(revisionnum, 0) DESC`;

const CURRENT_MAXIMO_PRS = Prisma.sql`
  SELECT DISTINCT ON (coalesce(prnum, ''), coalesce(contractnum, '')) *
  FROM maximo_contracts
  ORDER BY coalesce(prnum, ''), coalesce(contractnum, ''),
    coalesce(revisionnum, 0) DESC`;

export interface CurrencyAmount {
  currency: string | null;
  total: number;
  count: number;
}

export interface SourceCount {
  total: number;
  pendientes: number;
}

export interface SourceOrders {
  count: number;
  monto_por_moneda: CurrencyAmount[];
}

type CountRow = { total: number; pendientes: number };
type AmountRow = { currency: string | null; total: unknown; count: number };
type AvgRow = { dias: unknown };

function toNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toAmounts(rows: AmountRow[]): CurrencyAmount[] {
  return rows
    .map((r) => ({
      currency: r.currency,
      total: toNumber(r.total) ?? 0,
      count: Number(r.count),
    }))
    .filter((r) => r.count > 0);
}

/** Suma por moneda de varias fuentes (misma moneda se suma, distintas no). */
function mergeAmounts(lists: CurrencyAmount[][]): CurrencyAmount[] {
  const map = new Map<string, CurrencyAmount>();
  for (const list of lists) {
    for (const row of list) {
      const key = row.currency ?? 'sin_moneda';
      const entry = map.get(key) ?? {
        currency: row.currency,
        total: 0,
        count: 0,
      };
      entry.total += row.total;
      entry.count += row.count;
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function avgOrNull(rows: AvgRow[]): number | null {
  const value = toNumber(rows[0]?.dias);
  return value === null ? null : Math.round(value * 10) / 10;
}

@Injectable()
export class PurchaseDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getSummary() {
    const [
      sapPr,
      sapPrDias,
      sapPo,
      sapPoOpen,
      maximoPr,
      maximoPoDias,
      maximoPo,
      maximoPoOpen,
      abentRq,
      abentRqDias,
      abentPo,
      abentPoOpen,
      sapPoDias,
    ] = await Promise.all([
      // SAP — solicitudes de pedido
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (
                 WHERE document_status = 'bost_Open' AND cancelled IS DISTINCT FROM true
               )::int AS pendientes
        FROM sap_purchase_requests`),
      this.prisma.$queryRaw<AvgRow[]>(Prisma.sql`
        SELECT avg(extract(epoch FROM (coalesce(closing_date, update_date_source) - doc_date)) / 86400) AS dias
        FROM sap_purchase_requests
        WHERE document_status = 'bost_Close' AND cancelled IS DISTINCT FROM true
          AND doc_date IS NOT NULL
          AND coalesce(closing_date, update_date_source) >= doc_date`),
      // SAP — órdenes de compra (no canceladas), por moneda
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        SELECT currency, coalesce(sum(doc_total), 0) AS total, count(*)::int AS count
        FROM sap_purchase_orders WHERE cancelled IS DISTINCT FROM true
        GROUP BY currency`),
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        SELECT currency, coalesce(sum(doc_total), 0) AS total, count(*)::int AS count
        FROM sap_purchase_orders
        WHERE document_status = 'bost_Open' AND cancelled IS DISTINCT FROM true
        GROUP BY currency`),
      // Maximo — PR (raíz de maximo_contracts, vista actual)
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_PRS})
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status IN ('WAPPR', 'PNDREV'))::int AS pendientes
        FROM current WHERE prnum IS NOT NULL`),
      this.prisma.$queryRaw<AvgRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT avg(extract(epoch FROM (approved_at - coalesce(waiting_approval_at, created_at_source))) / 86400) AS dias
        FROM current
        WHERE approved_at IS NOT NULL
          AND coalesce(waiting_approval_at, created_at_source) IS NOT NULL
          AND approved_at >= coalesce(waiting_approval_at, created_at_source)`),
      // Maximo — OC vigentes (no canceladas), por moneda
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT currency, coalesce(sum(total_cost), 0) AS total, count(*)::int AS count
        FROM current WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL')
        GROUP BY currency`),
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT currency, coalesce(sum(total_cost), 0) AS total, count(*)::int AS count
        FROM current WHERE status IN ('APPR', 'INPRG')
        GROUP BY currency`),
      // ABENT — requisiciones propias
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status IN ('en_revision', 'en_aprobacion'))::int AS pendientes
        FROM requisitions WHERE is_active = true`),
      this.prisma.$queryRaw<AvgRow[]>(Prisma.sql`
        SELECT avg(business_days_elapsed) AS dias
        FROM requisitions
        WHERE is_active = true AND closed_date IS NOT NULL AND business_days_elapsed IS NOT NULL`),
      // ABENT — OC propias (el modelo propio no guarda moneda: MXN)
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        SELECT 'MXN'::text AS currency, coalesce(sum(amount), 0) AS total, count(*)::int AS count
        FROM purchase_orders WHERE is_active = true AND status <> 'cancelada'`),
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        SELECT 'MXN'::text AS currency, coalesce(sum(amount), 0) AS total, count(*)::int AS count
        FROM purchase_orders
        WHERE is_active = true AND status IN ('emitida', 'en_transito')`),
      // SAP — días de gestión de OC (mismo criterio que solicitudes)
      this.prisma.$queryRaw<AvgRow[]>(Prisma.sql`
        SELECT avg(extract(epoch FROM (coalesce(closing_date, update_date_source) - doc_date)) / 86400) AS dias
        FROM sap_purchase_orders
        WHERE document_status = 'bost_Close' AND cancelled IS DISTINCT FROM true
          AND doc_date IS NOT NULL
          AND coalesce(closing_date, update_date_source) >= doc_date`),
    ]);

    const src = (row: CountRow[] | undefined): SourceCount => ({
      total: Number(row?.[0]?.total ?? 0),
      pendientes: Number(row?.[0]?.pendientes ?? 0),
    });
    const orders = (rows: AmountRow[]): SourceOrders => {
      const amounts = toAmounts(rows);
      return {
        count: amounts.reduce((sum, r) => sum + r.count, 0),
        monto_por_moneda: amounts,
      };
    };

    const solicitudes = {
      sap: src(sapPr),
      maximo: src(maximoPr),
      abent: src(abentRq),
    };
    const ordenes = {
      sap: orders(sapPo),
      maximo: orders(maximoPo),
      abent: orders(abentPo),
    };
    const porRecibir = {
      sap: orders(sapPoOpen),
      maximo: orders(maximoPoOpen),
      abent: orders(abentPoOpen),
    };
    const sum = (o: Record<string, SourceOrders>) =>
      Object.values(o).reduce((s, v) => s + v.count, 0);

    return {
      solicitudes: {
        total:
          solicitudes.sap.total +
          solicitudes.maximo.total +
          solicitudes.abent.total,
        pendientes:
          solicitudes.sap.pendientes +
          solicitudes.maximo.pendientes +
          solicitudes.abent.pendientes,
        por_fuente: solicitudes,
      },
      // null = sin base para calcular en esa fuente ("No disponible").
      dias_gestion: {
        sap_solicitudes: avgOrNull(sapPrDias),
        sap_ordenes: avgOrNull(sapPoDias),
        maximo_ordenes: avgOrNull(maximoPoDias),
        abent_requisiciones: avgOrNull(abentRqDias),
      },
      ordenes: {
        total: sum(ordenes),
        monto_por_moneda: mergeAmounts(
          Object.values(ordenes).map((o) => o.monto_por_moneda),
        ),
        por_fuente: ordenes,
      },
      por_recibir: {
        total: sum(porRecibir),
        monto_por_moneda: mergeAmounts(
          Object.values(porRecibir).map((o) => o.monto_por_moneda),
        ),
        por_fuente: porRecibir,
      },
      fuentes: {
        sap_sync_enabled: this.flag('SAP_SYNC_ENABLED'),
        maximo_sync_enabled: this.flag('MAXIMO_SYNC_ENABLED'),
      },
      generated_at: new Date().toISOString(),
    };
  }

  /** Joi ya lo convirtió a boolean; se tolera el string por robustez. */
  private flag(name: string): boolean {
    const value = this.config.get<boolean | string>(name);
    return (
      value === true || (typeof value === 'string' && value.trim() === 'true')
    );
  }
}
