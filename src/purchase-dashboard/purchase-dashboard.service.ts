import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  andMaximoPrInWindow,
  andSapPoCountedOnce,
  andYear,
  CURRENT_MAXIMO_CONTRACTS,
  CURRENT_MAXIMO_POS,
  loadMaximoPrFolioWindow,
  pendingWindowStart,
  sapPoDuplicatedInMaximo,
} from '../common/sql/erp-views.sql';
import {
  MAXIMO_GESTION_DEFINICION,
  maximoGestionDays,
  SAP_GESTION_DEFINICION,
  sapGestionDays,
} from './sap-gestion-days';
import { loadPendingRequests } from './pending-requests';

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
 * Bloque 2026-09-23 (check-in Ingrid):
 *  - D1: una OC de SAP migrada desde Maximo (`maximo_ponum`) que EXISTE en
 *    el staging de Maximo se cuenta UNA vez en los totales combinados: se
 *    descuenta del lado de SAP. La tarjeta muestra el desglose
 *    ("de las cuales N migradas"). Las tarjetas por sistema siguen con su
 *    total propio (/sap/summary y /maximo/summary).
 *  - D3: días de gestión SAP OC = fecha de la OC − fecha de su solicitud de
 *    pedido base (la más antigua), solo OC con solicitud; N visible.
 *  - D4: filtro `year` (SAP por doc_date, Maximo por created_at_source,
 *    propias por created_at) y cabecera "datos desde… / última sync".
 *  - D5: `getOrdersKpis` — ahorro acumulado y CAPEX/OPEX por moneda.
 *
 * Reunión con Ingrid 2026-09-28:
 *  - G2: UNA definición de gestión por sistema (la de Ingrid: de que se crea
 *    la RQ a que se crea la OC), con promedio, mediana y N. SAP = D3; Maximo
 *    = fecha de la OC − PR.ISSUEDATE (`pr_issue_date`, 0016). Salen de aquí
 *    "SAP solicitudes" (cierre del documento, no es gestión) y el tiempo de
 *    aprobación de Maximo (vive en Aprobaciones/Reportes).
 *  - G3: pendientes de gestionar = RQ sin OC (ver pending-requests.ts), en el
 *    año elegido o en los últimos 12 meses.
 *
 * Definiciones (van también en los tooltips de las tarjetas):
 *  - Solicitudes: SAP por doc_date; Maximo PR (raíz de maximo_contracts)
 *    ubicadas por folio en el año (AB_CONTRATOS no expone su fecha).
 *  - Pendientes de gestionar: G3.
 *  - Días de gestión: G2; propias = business_days.
 *  - Por recibir: SAP OC abiertas no canceladas; Maximo OC APPR/INPRG;
 *    propias emitida/en_transito (enum po_status real de la BD). SAP no
 *    reporta "tránsito".
 */

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
type TotalRow = { total: number };
type AmountRow = { currency: string | null; total: unknown; count: number };
type AvgRow = { dias: unknown };
type MigratedRow = { total: number; en_maximo: number };
type RangeRow = {
  sap_desde: Date | null;
  maximo_desde: Date | null;
  sap_sync: Date | null;
  maximo_sync: Date | null;
};
type YearRow = { year: number };
type GestionPoRow = {
  doc_entry: number;
  doc_date: Date | null;
  base_request_entries: number[];
};
type GestionPrRow = { doc_entry: number; doc_date: Date | null };
type ClasRow = {
  clas: string | null;
  currency: string | null;
  docs: number;
  total: unknown;
};

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
export function mergeAmounts(lists: CurrencyAmount[][]): CurrencyAmount[] {
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

const iso = (value: Date | null | undefined) =>
  value ? value.toISOString() : null;

@Injectable()
export class PurchaseDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getSummary(year: number | null = null) {
    const sapPoYear = andYear('doc_date', year);
    const sapPrYear = andYear('doc_date', year);
    const maximoPoYear = andYear('created_at_source', year);
    const abentYear = andYear('created_at', year);
    const countedOnce = andSapPoCountedOnce('sap_purchase_orders');
    // G3: periodo de las solicitudes: el año elegido o, para los
    // pendientes sin año, los últimos 12 meses
    const yearFrom = year ? new Date(Date.UTC(year, 0, 1)) : null;
    const yearTo = year ? new Date(Date.UTC(year + 1, 0, 1)) : null;
    const [prYearWindow, pending] = await Promise.all([
      yearFrom
        ? loadMaximoPrFolioWindow(this.prisma, yearFrom, yearTo)
        : Promise.resolve(null),
      loadPendingRequests(
        this.prisma,
        yearFrom ?? pendingWindowStart(),
        yearTo,
      ),
    ]);

    const [
      sapPr,
      sapPo,
      sapPoOpen,
      maximoPr,
      maximoGestion,
      maximoPo,
      maximoPoOpen,
      abentRq,
      abentRqDias,
      abentPo,
      abentPoOpen,
      migradas,
      gestionPos,
      range,
      years,
    ] = await Promise.all([
      // SAP — solicitudes de pedido (los pendientes vienen de G3)
      this.prisma.$queryRaw<TotalRow[]>(Prisma.sql`
        SELECT count(*)::int AS total
        FROM sap_purchase_requests WHERE true ${sapPrYear}`),
      // SAP — órdenes de compra (no canceladas, contadas una vez), por moneda
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        SELECT currency, coalesce(sum(doc_total), 0) AS total, count(*)::int AS count
        FROM sap_purchase_orders
        WHERE cancelled IS DISTINCT FROM true ${countedOnce} ${sapPoYear}
        GROUP BY currency`),
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        SELECT currency, coalesce(sum(doc_total), 0) AS total, count(*)::int AS count
        FROM sap_purchase_orders
        WHERE document_status = 'bost_Open' AND cancelled IS DISTINCT FROM true
          ${countedOnce} ${sapPoYear}
        GROUP BY currency`),
      // Maximo — PR (raíz de maximo_contracts, vista actual); con año, por folio
      this.prisma.$queryRaw<TotalRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_CONTRACTS})
        SELECT count(*)::int AS total
        FROM current c WHERE c.prnum IS NOT NULL
          ${andMaximoPrInWindow('c', prYearWindow)}`),
      // G2: días de gestión Maximo = fecha de la OC − PR.ISSUEDATE
      this.prisma.$queryRaw<Array<{ dias: unknown }>>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT CASE WHEN pr_issue_date IS NOT NULL AND created_at_source IS NOT NULL
                    THEN extract(epoch FROM (created_at_source - pr_issue_date)) / 86400
               END AS dias
        FROM current
        WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL') ${maximoPoYear}`),
      // Maximo — OC vigentes (no canceladas), por moneda
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT currency, coalesce(sum(total_cost), 0) AS total, count(*)::int AS count
        FROM current WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL') ${maximoPoYear}
        GROUP BY currency`),
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT currency, coalesce(sum(total_cost), 0) AS total, count(*)::int AS count
        FROM current WHERE status IN ('APPR', 'INPRG') ${maximoPoYear}
        GROUP BY currency`),
      // ABENT — requisiciones propias
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status IN ('en_revision', 'en_aprobacion'))::int AS pendientes
        FROM requisitions WHERE is_active = true ${abentYear}`),
      this.prisma.$queryRaw<AvgRow[]>(Prisma.sql`
        SELECT avg(business_days_elapsed) AS dias
        FROM requisitions
        WHERE is_active = true AND closed_date IS NOT NULL AND business_days_elapsed IS NOT NULL ${abentYear}`),
      // ABENT — OC propias (el modelo propio no guarda moneda: MXN)
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        SELECT 'MXN'::text AS currency, coalesce(sum(amount), 0) AS total, count(*)::int AS count
        FROM purchase_orders WHERE is_active = true AND status <> 'cancelada' ${abentYear}`),
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        SELECT 'MXN'::text AS currency, coalesce(sum(amount), 0) AS total, count(*)::int AS count
        FROM purchase_orders
        WHERE is_active = true AND status IN ('emitida', 'en_transito') ${abentYear}`),
      // D1 — OC de SAP migradas desde Maximo: cuántas y cuántas existen allá
      this.prisma.$queryRaw<MigratedRow[]>(Prisma.sql`
        SELECT count(*) FILTER (WHERE maximo_ponum IS NOT NULL)::int AS total,
               count(*) FILTER (WHERE ${sapPoDuplicatedInMaximo('sap_purchase_orders')})::int AS en_maximo
        FROM sap_purchase_orders
        WHERE cancelled IS DISTINCT FROM true ${sapPoYear}`),
      // D3 — OC con solicitud base (se calcula en memoria con función pura)
      this.prisma.$queryRaw<GestionPoRow[]>(Prisma.sql`
        SELECT doc_entry, doc_date, base_request_entries
        FROM sap_purchase_orders
        WHERE cancelled IS DISTINCT FROM true
          AND cardinality(base_request_entries) > 0 ${sapPoYear}`),
      // D4 — desde cuándo hay datos y última sincronización exitosa
      this.prisma.$queryRaw<RangeRow[]>(Prisma.sql`
        SELECT (SELECT min(doc_date) FROM sap_purchase_orders) AS sap_desde,
               (SELECT min(created_at_source) FROM maximo_purchase_orders) AS maximo_desde,
               (SELECT max(finished_at) FROM sap_sync_runs WHERE status = 'success') AS sap_sync,
               (SELECT max(finished_at) FROM maximo_sync_runs WHERE status = 'success') AS maximo_sync`),
      this.prisma.$queryRaw<YearRow[]>(Prisma.sql`
        SELECT DISTINCT extract(year FROM d)::int AS year FROM (
          SELECT doc_date AS d FROM sap_purchase_orders
          UNION ALL SELECT doc_date FROM sap_purchase_requests
          UNION ALL SELECT created_at_source FROM maximo_purchase_orders
          UNION ALL SELECT created_at_source FROM maximo_contracts
        ) t WHERE d IS NOT NULL ORDER BY 1 DESC`),
    ]);

    // D3: fechas de las solicitudes base referidas por esas OC
    const requestEntries = [
      ...new Set(gestionPos.flatMap((po) => po.base_request_entries)),
    ];
    const gestionPrs =
      requestEntries.length === 0
        ? []
        : await this.prisma.$queryRaw<GestionPrRow[]>(Prisma.sql`
            SELECT doc_entry, doc_date FROM sap_purchase_requests
            WHERE doc_entry IN (${Prisma.join(requestEntries)})`);
    const sapOcGestion = sapGestionDays(gestionPos, gestionPrs);
    const maximoOcGestion = maximoGestionDays(maximoGestion);

    const src = (row: CountRow[] | undefined): SourceCount => ({
      total: Number(row?.[0]?.total ?? 0),
      pendientes: Number(row?.[0]?.pendientes ?? 0),
    });
    const totalOf = (rows: TotalRow[]) => Number(rows[0]?.total ?? 0);
    const orders = (rows: AmountRow[]): SourceOrders => {
      const amounts = toAmounts(rows);
      return {
        count: amounts.reduce((sum, r) => sum + r.count, 0),
        monto_por_moneda: amounts,
      };
    };

    const solicitudes = {
      sap: {
        total: totalOf(sapPr),
        pendientes: pending.sap.pendientes,
        pendientes_sin_limite: pending.sap.sin_limite,
      },
      maximo: {
        total: totalOf(maximoPr),
        // null = sin fechas de PR conocidas para ubicar el periodo
        pendientes: pending.maximo.pendientes,
        pendientes_sin_limite: pending.maximo.sin_limite,
      },
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
    const migradasInfo = {
      total: Number(migradas[0]?.total ?? 0),
      // Descontadas del lado SAP en los totales combinados (existen en Maximo).
      en_maximo: Number(migradas[0]?.en_maximo ?? 0),
    };

    return {
      anio: year,
      solicitudes: {
        total:
          solicitudes.sap.total +
          solicitudes.maximo.total +
          solicitudes.abent.total,
        pendientes:
          solicitudes.sap.pendientes +
          (solicitudes.maximo.pendientes ?? 0) +
          solicitudes.abent.pendientes,
        por_fuente: solicitudes,
        // G3: periodo de los pendientes (año elegido o últimos 12 meses)
        pendientes_periodo: { desde: pending.desde, hasta: pending.hasta },
      },
      // G2: una definición por sistema; null = sin base ("No disponible").
      dias_gestion: {
        sap: { ...sapOcGestion, definicion: SAP_GESTION_DEFINICION },
        maximo: { ...maximoOcGestion, definicion: MAXIMO_GESTION_DEFINICION },
        abent: avgOrNull(abentRqDias),
      },
      ordenes: {
        total: sum(ordenes),
        monto_por_moneda: mergeAmounts(
          Object.values(ordenes).map((o) => o.monto_por_moneda),
        ),
        por_fuente: ordenes,
        migradas: migradasInfo,
      },
      por_recibir: {
        total: sum(porRecibir),
        monto_por_moneda: mergeAmounts(
          Object.values(porRecibir).map((o) => o.monto_por_moneda),
        ),
        por_fuente: porRecibir,
      },
      datos: {
        sap_desde: iso(range[0]?.sap_desde),
        maximo_desde: iso(range[0]?.maximo_desde),
        ultima_sync: {
          sap: iso(range[0]?.sap_sync),
          maximo: iso(range[0]?.maximo_sync),
        },
        anios: years.map((y) => Number(y.year)),
      },
      fuentes: {
        sap_sync_enabled: this.flag('SAP_SYNC_ENABLED'),
        maximo_sync_enabled: this.flag('MAXIMO_SYNC_ENABLED'),
      },
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * D5 — Tarjetas de Órdenes: ahorro acumulado (U_Imp_ahorro de SAP +
   * AB_AHORRO de Maximo) y CAPEX/OPEX (U_Clas_gts por línea en SAP; AB_CLASFPO
   * en Maximo). Por moneda y por fuente; respeta el año (D4) y no cuenta dos
   * veces las OC migradas (D1). Sin captura → `disponible=false` (la UI
   * muestra "No disponible (sin captura)", nunca 0).
   */
  async getOrdersKpis(year: number | null = null) {
    const sapYear = andYear('po.doc_date', year);
    const maximoYear = andYear('created_at_source', year);
    const countedOnce = andSapPoCountedOnce('po');

    const [sapAhorro, maximoAhorro, sapClas, maximoClas] = await Promise.all([
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        SELECT po.currency, coalesce(sum(po.ahorro_total), 0) AS total, count(*)::int AS count
        FROM sap_purchase_orders po
        WHERE po.cancelled IS DISTINCT FROM true AND po.ahorro_total IS NOT NULL
          ${countedOnce} ${sapYear}
        GROUP BY po.currency`),
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT currency, coalesce(sum(ab_ahorro), 0) AS total, count(*)::int AS count
        FROM current
        WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL') AND ab_ahorro IS NOT NULL ${maximoYear}
        GROUP BY currency`),
      // SAP: la clasificación vive en la línea (U_Clas_gts); el importe de
      // la línea va en la moneda del documento (LineTotal en MXN, RowTotalFC
      // en documentos extranjeros — misma regla que el mapper 1.2.0).
      this.prisma.$queryRaw<ClasRow[]>(Prisma.sql`
        SELECT upper(line->>'U_Clas_gts') AS clas, po.currency,
               count(DISTINCT po.doc_entry)::int AS docs,
               coalesce(sum(CASE WHEN po.currency IS NULL OR po.currency = 'MXN'
                                 THEN NULLIF(line->>'LineTotal', '')::numeric
                                 ELSE NULLIF(line->>'RowTotalFC', '')::numeric END), 0) AS total
        FROM sap_purchase_orders po,
             jsonb_array_elements(coalesce(po.raw::jsonb->'DocumentLines', '[]'::jsonb)) line
        WHERE po.cancelled IS DISTINCT FROM true
          AND upper(line->>'U_Clas_gts') IN ('CAPEX', 'OPEX')
          ${countedOnce} ${sapYear}
        GROUP BY 1, 2`),
      this.prisma.$queryRaw<ClasRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT upper(ab_clasfpo) AS clas, currency, count(*)::int AS docs,
               coalesce(sum(total_cost), 0) AS total
        FROM current
        WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL')
          AND upper(ab_clasfpo) IN ('CAPEX', 'OPEX') ${maximoYear}
        GROUP BY 1, 2`),
    ]);

    const ahorroSap = toAmounts(sapAhorro);
    const ahorroMaximo = toAmounts(maximoAhorro);
    const docs = (list: CurrencyAmount[]) =>
      list.reduce((s, r) => s + r.count, 0);
    const clasOf = (rows: ClasRow[], clas: 'CAPEX' | 'OPEX') =>
      toAmounts(
        rows
          .filter((r) => r.clas === clas)
          .map((r) => ({
            currency: r.currency,
            total: r.total,
            count: r.docs,
          })),
      );
    const clas = (key: 'CAPEX' | 'OPEX') => {
      const sap = clasOf(sapClas, key);
      const maximo = clasOf(maximoClas, key);
      return {
        por_moneda: mergeAmounts([sap, maximo]),
        documentos: docs(sap) + docs(maximo),
        por_fuente: {
          sap: { documentos: docs(sap), por_moneda: sap },
          maximo: { documentos: docs(maximo), por_moneda: maximo },
        },
      };
    };
    const capex = clas('CAPEX');
    const opex = clas('OPEX');

    return {
      anio: year,
      ahorro: {
        disponible: docs(ahorroSap) + docs(ahorroMaximo) > 0,
        documentos: docs(ahorroSap) + docs(ahorroMaximo),
        por_moneda: mergeAmounts([ahorroSap, ahorroMaximo]),
        por_fuente: {
          sap: { documentos: docs(ahorroSap), por_moneda: ahorroSap },
          maximo: { documentos: docs(ahorroMaximo), por_moneda: ahorroMaximo },
        },
        nota: 'SAP: U_Imp_ahorro por línea (captura de Compras desde 2026-09-15, incremental). Maximo: AB_AHORRO (la Object Structure aún no lo expone).',
      },
      clasificacion: {
        disponible: capex.documentos + opex.documentos > 0,
        capex,
        opex,
        nota: 'SAP: U_Clas_gts por línea (una OC con líneas CAPEX y OPEX cuenta en ambas). Maximo: AB_CLASFPO (pendiente CIISA).',
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
