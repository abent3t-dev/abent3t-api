import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import {
  abentMontoEnBase,
  andSapPoCountedOnce,
  andYear,
  CURRENT_MAXIMO_POS,
  CURRENT_MAXIMO_PRS,
  maximoGestionSql,
  maximoPoMonto,
  type MontoBase,
  montoBaseNota,
  pendingWindowStart,
  poSubtotalColumns,
  sapGestionSql,
  sapPoDuplicatedInMaximo,
  sapPoMonto,
  TABLERO_MONTO_BASE,
} from '../common/sql/erp-views.sql';
import type {
  MaximoGestionRow,
  SapGestionRow,
} from '../common/sql/erp-views.sql';
import {
  MAXIMO_GESTION_APROBACION_DEFINICION,
  MAXIMO_GESTION_DEFINICION,
  maximoGestion,
  SAP_GESTION_DEFINICION,
  sapGestionDays,
} from './sap-gestion-days';
import { loadPendingRequests } from './pending-requests';
import {
  type AhorroEntry,
  buildAhorro,
  buildGestionPorComprador,
  maximoKpiBuyer,
  sapBuyer,
} from './buyer-kpis';

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
 * Bloque K (2026-10-05, K4): sin folio. Las PR de Maximo se cuentan por PR
 * (`CURRENT_MAXIMO_PRS`) con su fecha real; pendientes = APPR sin OC ni
 * contrato (las WAPPR van aparte) y G2 toma la fecha de la PR de
 * AB_CONTRATOS cuando la línea de la OC no la trae.
 *
 * Definiciones (van también en los tooltips de las tarjetas):
 *  - Solicitudes: SAP por doc_date; Maximo PR distintas por su creación
 *    (`pr_issue_date`, ISSUEDATE), con "N llegaron a Compras" (primer APPR).
 *  - Pendientes de gestionar: G3.
 *  - Días de gestión: G2; propias = business_days.
 *  - Por recibir: SAP OC abiertas no canceladas; Maximo OC APPR/INPRG;
 *    propias emitida/en_transito (enum po_status real de la BD). SAP no
 *    reporta "tránsito".
 *
 * K6 (2026-10-05): los montos de Órdenes van en la base de
 * `TABLERO_MONTO_BASE` (con IVA hasta que conteste Ingrid) con el subtotal
 * sin IVA y las OC sin él como dato secundario, por moneda. "Por recibir"
 * se queda con IVA. CAPEX/OPEX suma sin IVA en las dos fuentes.
 *
 * Bloque M (2026-10-14, Ingrid): Órdenes trae el ahorro (M1) y los días de
 * gestión de G2 (M2) POR COMPRADOR (regla E4/F1; ver buyer-kpis.ts). Las OC
 * de G2 de SAP salen de `sapGestionSql`, la misma consulta para el tablero y
 * Órdenes.
 */

export interface CurrencyAmount {
  currency: string | null;
  /** Monto de la tarjeta (Órdenes: en la base de `TABLERO_MONTO_BASE`). */
  total: number;
  count: number;
  /**
   * K6: dato secundario sin IVA = suma del `subtotal` de las OC que lo
   * tienen; `sin_subtotal` = cuántas no lo tienen (sin líneas o con alguna
   * sin importe; las propias de ABENT siempre: base desconocida). Solo en
   * Órdenes: por recibir, ahorro y CAPEX/OPEX no lo traen.
   */
  subtotal?: number;
  sin_subtotal?: number;
}

/**
 * H7 (2026-10-05): monto de CAPEX/OPEX por moneda (siempre sin IVA).
 * `sin_subtotal` = OC de Maximo de esa moneda sin subtotal (cuentan en
 * `count`, no en `total`); `monto_disponible` = false cuando ninguna OC de
 * la moneda trae el monto (todas sin subtotal): el front pinta "No
 * disponible", no $0.00.
 */
export interface ClasAmount extends CurrencyAmount {
  sin_subtotal: number;
  monto_disponible: boolean;
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
type MaximoPrTotalRow = { total: number; llegaron: number };
type AmountRow = {
  currency: string | null;
  total: unknown;
  count: number;
  /** K6: solo en las consultas de OC con `poSubtotalColumns`. */
  subtotal?: unknown;
  sin_subtotal?: number;
};
type AvgRow = { dias: unknown };
type MigratedRow = { total: number; en_maximo: number };
type RangeRow = {
  sap_desde: Date | null;
  maximo_desde: Date | null;
  sap_sync: Date | null;
  maximo_sync: Date | null;
};
type YearRow = { year: number };
type GestionPrRow = { doc_entry: number; doc_date: Date | null };
/** M1: ahorro de SAP por quien capturó la OC y moneda. */
type SapAhorroRow = {
  currency: string | null;
  created_by_name: string | null;
  total: unknown;
  count: number;
};
/** E4/F1: lo que necesita `maximoBuyer` de una OC de Maximo. */
type MaximoBuyerFields = {
  purchase_agent?: string | null;
  purchase_agent_name?: string | null;
  created_by?: string | null;
};
/** M1: ahorro de Maximo por PURCHASEAGENT/creador y moneda. */
type MaximoAhorroRow = MaximoBuyerFields & {
  currency: string | null;
  total: unknown;
  count: number;
};
/** M2: comprador de Maximo de una OC de SAP que nació allá (por PONUM). */
type MaximoPonumBuyerRow = MaximoBuyerFields & { ponum: string };
type ClasRow = {
  clas: string | null;
  currency: string | null;
  docs: number;
  total: unknown;
  /** K6: Maximo, OC clasificadas sin subtotal (no suman al monto). */
  sin_subtotal?: number;
};

function toNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toAmounts(rows: AmountRow[]): CurrencyAmount[] {
  return rows
    .map(
      (r): CurrencyAmount => ({
        currency: r.currency,
        total: toNumber(r.total) ?? 0,
        count: Number(r.count),
        // K6: solo las consultas de OC traen el subtotal
        ...(r.subtotal === undefined
          ? {}
          : {
              subtotal: toNumber(r.subtotal) ?? 0,
              sin_subtotal: Number(r.sin_subtotal ?? 0),
            }),
      }),
    )
    .filter((r) => r.count > 0);
}

/**
 * K6: OC propias de ABENT. El modelo propio no dice si `amount` lleva IVA
 * (base desconocida): no suman al subtotal y van todas a `sin_subtotal`.
 * H10 (2026-10-05): con base sin IVA tampoco suman al total
 * (`abentMontoEnBase`, la misma regla del Resumen de Reportes).
 */
export function abentAmounts(
  rows: AmountRow[],
  base: MontoBase = TABLERO_MONTO_BASE,
): CurrencyAmount[] {
  return toAmounts(rows).map((r) => ({
    ...r,
    ...abentMontoEnBase(r.total, r.count, base),
  }));
}

/**
 * Suma por moneda de varias fuentes (misma moneda se suma, distintas no).
 * K6: también suma `subtotal` y `sin_subtotal` cuando las filas los traen.
 */
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
      if (row.subtotal !== undefined || row.sin_subtotal !== undefined) {
        entry.subtotal = (entry.subtotal ?? 0) + (row.subtotal ?? 0);
        entry.sin_subtotal =
          (entry.sin_subtotal ?? 0) + (row.sin_subtotal ?? 0);
      }
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

/**
 * D4: [1-ene, 1-ene del siguiente) del año elegido; sin año, sin límites.
 * M2: el mismo periodo de G2 en el tablero y en Órdenes.
 */
function yearBounds(year: number | null): {
  from: Date | null;
  toExcl: Date | null;
} {
  return year
    ? {
        from: new Date(Date.UTC(year, 0, 1)),
        toExcl: new Date(Date.UTC(year + 1, 0, 1)),
      }
    : { from: null, toExcl: null };
}

@Injectable()
export class PurchaseDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    // M1/M2: PURCHASEAGENT y creador de Maximo son códigos → alias de Compras
    private readonly aliases: ErpAliasesService,
  ) {}

  async getSummary(year: number | null = null) {
    const sapPoYear = andYear('doc_date', year);
    const sapPrYear = andYear('doc_date', year);
    const maximoPoYear = andYear('created_at_source', year);
    const abentYear = andYear('created_at', year);
    const countedOnce = andSapPoCountedOnce('sap_purchase_orders');
    // G3: periodo de los pendientes: el año elegido o, sin año, los últimos
    // 12 meses
    const { from: yearFrom, toExcl: yearTo } = yearBounds(year);

    const [
      pending,
      sapPr,
      sapPo,
      sapPoOpen,
      maximoPr,
      maximoGestionRows,
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
      loadPendingRequests(
        this.prisma,
        yearFrom ?? pendingWindowStart(),
        yearTo,
      ),
      // SAP — solicitudes de pedido (los pendientes vienen de G3)
      this.prisma.$queryRaw<TotalRow[]>(Prisma.sql`
        SELECT count(*)::int AS total
        FROM sap_purchase_requests WHERE true ${sapPrYear}`),
      // SAP — órdenes de compra (no canceladas, contadas una vez), por moneda;
      // K6: en la base del tablero, con el subtotal sin IVA de dato
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        SELECT currency,
               coalesce(sum(${sapPoMonto('sap_purchase_orders', TABLERO_MONTO_BASE)}), 0) AS total,
               ${poSubtotalColumns('sap_purchase_orders')}, count(*)::int AS count
        FROM sap_purchase_orders
        WHERE cancelled IS DISTINCT FROM true ${countedOnce} ${sapPoYear}
        GROUP BY currency`),
      // por recibir: sin cambio en K6 (con IVA)
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        SELECT currency, coalesce(sum(doc_total), 0) AS total, count(*)::int AS count
        FROM sap_purchase_orders
        WHERE document_status = 'bost_Open' AND cancelled IS DISTINCT FROM true
          ${countedOnce} ${sapPoYear}
        GROUP BY currency`),
      // K4.3: Maximo — PR distintas por su creación (ISSUEDATE), como SAP por
      // doc_date; `llegaron` = con primer APPR (llegaron a Compras)
      this.prisma.$queryRaw<MaximoPrTotalRow[]>(Prisma.sql`
        WITH prs AS (${CURRENT_MAXIMO_PRS})
        SELECT count(DISTINCT p.prnum)::int AS total,
               count(DISTINCT p.prnum) FILTER (WHERE p.pr_approved_at IS NOT NULL)::int AS llegaron
        FROM prs p WHERE true ${andYear('p.pr_issue_date', year)}`),
      // G2: días de gestión Maximo = fecha de la OC − creación de su PR
      // (K4.3: con el respaldo de AB_CONTRATOS y el dato desde la aprobación)
      this.prisma.$queryRaw<MaximoGestionRow[]>(
        maximoGestionSql(yearFrom, yearTo),
      ),
      // Maximo — OC vigentes (no canceladas), por moneda; K6: en la base del
      // tablero, con el subtotal sin IVA (Σ LINECOST) de dato
      this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT c.currency,
               coalesce(sum(${maximoPoMonto('c', TABLERO_MONTO_BASE)}), 0) AS total,
               ${poSubtotalColumns('c')}, count(*)::int AS count
        FROM current c WHERE coalesce(c.status, '') NOT IN ('CAN', 'CANCEL') ${maximoPoYear}
        GROUP BY c.currency`),
      // por recibir: sin cambio en K6 (con IVA)
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
      // D3 — OC con solicitud base (se calcula en memoria con función pura);
      // M2: la misma consulta que la gráfica por comprador de Órdenes
      this.prisma.$queryRaw<SapGestionRow[]>(sapGestionSql(yearFrom, yearTo)),
      // D4 — desde cuándo hay datos y última sincronización exitosa
      this.prisma.$queryRaw<RangeRow[]>(Prisma.sql`
        SELECT (SELECT min(doc_date) FROM sap_purchase_orders) AS sap_desde,
               (SELECT min(created_at_source) FROM maximo_purchase_orders) AS maximo_desde,
               (SELECT max(finished_at) FROM sap_sync_runs WHERE status = 'success') AS sap_sync,
               (SELECT max(finished_at) FROM maximo_sync_runs WHERE status = 'success') AS maximo_sync`),
      // K4.3: las PR de Maximo entran al selector por su creación
      // (ISSUEDATE) en la vista por PR, sin las revisiones obsoletas; antes
      // era la fecha del contrato y la PR sin contrato no tenía año.
      this.prisma.$queryRaw<YearRow[]>(Prisma.sql`
        SELECT DISTINCT extract(year FROM d)::int AS year FROM (
          SELECT doc_date AS d FROM sap_purchase_orders
          UNION ALL SELECT doc_date FROM sap_purchase_requests
          UNION ALL SELECT created_at_source FROM maximo_purchase_orders
          UNION ALL SELECT pr_issue_date FROM (${CURRENT_MAXIMO_PRS}) prs
        ) t WHERE d IS NOT NULL ORDER BY 1 DESC`),
    ]);

    // D3: fechas de las solicitudes base referidas por esas OC
    const gestionPrs = await this.sapGestionRequests(gestionPos);
    const sapOcGestion = sapGestionDays(gestionPos, gestionPrs);
    const maximoOcGestion = maximoGestion(maximoGestionRows);

    const src = (row: CountRow[] | undefined): SourceCount => ({
      total: Number(row?.[0]?.total ?? 0),
      pendientes: Number(row?.[0]?.pendientes ?? 0),
    });
    const totalOf = (rows: TotalRow[]) => Number(rows[0]?.total ?? 0);
    const orders = (
      rows: AmountRow[],
      amountsOf: (rows: AmountRow[]) => CurrencyAmount[] = toAmounts,
    ): SourceOrders => {
      const amounts = amountsOf(rows);
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
        // H8: con año y sin ninguna PR con estatus, el conteo por ISSUEDATE
        // da 0 sin base → null; sin año cuenta todas las PR (dato)
        total:
          year !== null && pending.maximo.pendientes === null
            ? null
            : totalOf(maximoPr),
        // K4.3: de esas, las que llegaron a Compras (primer APPR); null =
        // ninguna PR tiene estatus todavía (antes del primer full)
        llegaron_a_compras:
          pending.maximo.pendientes === null
            ? null
            : Number(maximoPr[0]?.llegaron ?? 0),
        // K4: APPR sin OC ni contrato, por fecha de aprobación; null = sin base
        pendientes: pending.maximo.pendientes,
        pendientes_sin_limite: pending.maximo.sin_limite,
        // I8: APPR de contrato sin OC, aparte (la OC se genera en automático)
        de_contrato: pending.maximo.de_contrato,
        de_contrato_sin_limite: pending.maximo.de_contrato_sin_limite,
        // K4: APPR que ya tienen OC (dato): pendientes + de_contrato + estas = APPR
        aprobadas_con_oc: pending.maximo.aprobadas_con_oc,
        aprobadas_con_oc_sin_limite: pending.maximo.aprobadas_con_oc_sin_limite,
        // K4: WAPPR (todavía no llegan a Compras), por emisión; no se suman
        en_aprobacion: pending.maximo.en_aprobacion,
        en_aprobacion_sin_limite: pending.maximo.en_aprobacion_sin_limite,
      },
      abent: src(abentRq),
    };
    const ordenes = {
      sap: orders(sapPo),
      maximo: orders(maximoPo),
      // K6: base desconocida → todas a sin_subtotal (H10: sin IVA, fuera del total)
      abent: orders(abentPo, (rows) => abentAmounts(rows)),
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
          (solicitudes.maximo.total ?? 0) +
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
        maximo: {
          ...maximoOcGestion.creacion,
          definicion: MAXIMO_GESTION_DEFINICION,
        },
        // K4.3: dato secundario, desde la llegada a Compras (primer APPR)
        maximo_desde_aprobacion: {
          ...maximoOcGestion.desde_aprobacion,
          definicion: MAXIMO_GESTION_APROBACION_DEFINICION,
        },
        abent: avgOrNull(abentRqDias),
      },
      ordenes: {
        total: sum(ordenes),
        monto_por_moneda: mergeAmounts(
          Object.values(ordenes).map((o) => o.monto_por_moneda),
        ),
        por_fuente: ordenes,
        migradas: migradasInfo,
        // K6: base de `total`; `subtotal` (sin IVA) y `sin_subtotal` van
        // por moneda como dato secundario
        monto_base: TABLERO_MONTO_BASE,
        monto_nota: montoBaseNota(TABLERO_MONTO_BASE),
      },
      por_recibir: {
        total: sum(porRecibir),
        monto_por_moneda: mergeAmounts(
          Object.values(porRecibir).map((o) => o.monto_por_moneda),
        ),
        por_fuente: porRecibir,
        // K6: se queda con IVA, sin subtotal
        monto_base: 'con_iva' as const,
        monto_nota: montoBaseNota('con_iva'),
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
   *
   * K6 (2026-10-05): CAPEX/OPEX va sin IVA en las dos fuentes. SAP ya
   * sumaba el importe de la línea; Maximo sumaba TOTALCOST (con IVA) y la
   * tarjeta mezclaba bases: ahora suma el `subtotal` (Σ LINECOST). Las OC
   * clasificadas sin subtotal cuentan en documentos, no en el monto, y la
   * nota dice cuántas son. No depende de TABLERO_MONTO_BASE.
   *
   * Bloque M (2026-10-14, Ingrid: "para que los compradores compitan"):
   *  - M1: `ahorro.por_comprador`. Las consultas de ahorro se agrupan por
   *    comprador Y moneda, y de esas filas salen la tarjeta (por moneda y
   *    por fuente) y las barras: la suma de las barras = la tarjeta.
   *  - M2: `gestion_por_comprador`: los días de G2 del tablero (mismas OC,
   *    mismo periodo, mismas funciones) agrupados por comprador, por sistema.
   */
  async getOrdersKpis(year: number | null = null) {
    const sapYear = andYear('po.doc_date', year);
    const maximoYear = andYear('created_at_source', year);
    const countedOnce = andSapPoCountedOnce('po');
    // M2: el periodo de G2 del tablero (getSummary)
    const { from: yearFrom, toExcl: yearTo } = yearBounds(year);

    const [
      sapAhorro,
      maximoAhorro,
      sapClas,
      maximoClas,
      gestionPos,
      maximoGestionRows,
    ] = await Promise.all([
      // M1: ahorro de SAP por quien capturó la OC y moneda. D1: la OC migrada
      // que existe en Maximo NO llega aquí; se cuenta una vez, del lado de
      // Maximo, con el comprador de Maximo. Las que llegan son de SAP (o
      // migradas cuyo PONUM no está en Maximo): su comprador es quien las
      // capturó en SAP (E4).
      this.prisma.$queryRaw<SapAhorroRow[]>(Prisma.sql`
        SELECT po.currency, po.created_by_name,
               coalesce(sum(po.ahorro_total), 0) AS total, count(*)::int AS count
        FROM sap_purchase_orders po
        WHERE po.cancelled IS DISTINCT FROM true AND po.ahorro_total IS NOT NULL
          ${countedOnce} ${sapYear}
        GROUP BY po.currency, po.created_by_name`),
      // M1: ahorro de Maximo por PURCHASEAGENT / creador (E4/F1) y moneda
      this.prisma.$queryRaw<MaximoAhorroRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT currency, purchase_agent, purchase_agent_name, created_by,
               coalesce(sum(ab_ahorro), 0) AS total, count(*)::int AS count
        FROM current
        WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL') AND ab_ahorro IS NOT NULL ${maximoYear}
        GROUP BY currency, purchase_agent, purchase_agent_name, created_by`),
      // SAP: la clasificación vive en la línea (U_Clas_gts); el importe de
      // la línea (sin IVA) va en la moneda del documento (LineTotal en MXN,
      // RowTotalFC en documentos extranjeros — misma regla que el mapper).
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
      // Maximo: AB_CLASFPO de la OC; K6: monto sin IVA (subtotal), igual
      // que SAP
      this.prisma.$queryRaw<ClasRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT upper(ab_clasfpo) AS clas, currency, count(*)::int AS docs,
               sum(${maximoPoMonto('current', 'sin_iva')}) AS total,
               count(*) FILTER (WHERE subtotal IS NULL)::int AS sin_subtotal
        FROM current
        WHERE coalesce(status, '') NOT IN ('CAN', 'CANCEL')
          AND upper(ab_clasfpo) IN ('CAPEX', 'OPEX') ${maximoYear}
        GROUP BY 1, 2`),
      // M2: las MISMAS OC de G2 que el tablero (misma consulta y periodo)
      this.prisma.$queryRaw<SapGestionRow[]>(sapGestionSql(yearFrom, yearTo)),
      this.prisma.$queryRaw<MaximoGestionRow[]>(
        maximoGestionSql(yearFrom, yearTo),
      ),
    ]);

    // M2: fechas de las solicitudes base (D3) y comprador de Maximo de las OC
    // de SAP que nacieron allá
    const ponums = [
      ...new Set(
        gestionPos.map((po) => po.maximo_ponum).filter((p): p is string => !!p),
      ),
    ];
    const [gestionPrs, ponumBuyers] = await Promise.all([
      this.sapGestionRequests(gestionPos),
      this.maximoBuyersByPonum(ponums),
    ]);
    // E4/F1: PURCHASEAGENT y creador son códigos → alias de Compras
    const names = await this.aliases.resolveMany(
      'maximo',
      [...maximoAhorro, ...maximoGestionRows, ...ponumBuyers].flatMap((r) => [
        r.purchase_agent,
        r.created_by,
      ]),
    );
    // E4/F1 con el alias de Compras (el del alias nombra la barra)
    const buyerOfMaximo = (r: MaximoBuyerFields) => maximoKpiBuyer(r, names);
    const maximoByPonum = new Map(
      ponumBuyers.map((m) => [m.ponum, buyerOfMaximo(m)]),
    );

    // M1: una sola lista de renglones para la tarjeta y las barras
    const ahorro = buildAhorro([
      ...sapAhorro.map(
        (r): AhorroEntry => ({
          fuente: 'sap',
          currency: r.currency,
          buyer: sapBuyer(r.created_by_name),
          total: toNumber(r.total) ?? 0,
          count: Number(r.count),
        }),
      ),
      ...maximoAhorro.map(
        (r): AhorroEntry => ({
          fuente: 'maximo',
          currency: r.currency,
          buyer: buyerOfMaximo(r),
          total: toNumber(r.total) ?? 0,
          count: Number(r.count),
        }),
      ),
    ]);
    // M2: G2 es por sistema (sin D1). La OC de SAP que nació en Maximo y
    // existe allá toma el comprador de Maximo, nunca el usuario de la
    // integración; si no, quien la capturó en SAP (E4/F1).
    const gestionPorComprador = buildGestionPorComprador(
      {
        pos: gestionPos.map((po) => ({
          ...po,
          buyer:
            (po.maximo_ponum
              ? maximoByPonum.get(po.maximo_ponum)
              : undefined) ?? sapBuyer(po.created_by_name),
        })),
        requests: gestionPrs,
      },
      maximoGestionRows.map((r) => ({ ...r, buyer: buyerOfMaximo(r) })),
    );

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
      // K6: OC de Maximo clasificadas sin subtotal (fuera del monto); H7:
      // también por moneda, para no pintar $0.00 sin base
      const faltanPorMoneda = new Map<string, number>();
      for (const r of maximoClas.filter((row) => row.clas === key)) {
        const moneda = r.currency ?? 'sin_moneda';
        faltanPorMoneda.set(
          moneda,
          (faltanPorMoneda.get(moneda) ?? 0) + Number(r.sin_subtotal ?? 0),
        );
      }
      const sinSubtotal = [...faltanPorMoneda.values()].reduce(
        (s, n) => s + n,
        0,
      );
      const conDisponible = (list: CurrencyAmount[]): ClasAmount[] =>
        list.map((a) => {
          const faltan = faltanPorMoneda.get(a.currency ?? 'sin_moneda') ?? 0;
          return {
            ...a,
            sin_subtotal: faltan,
            monto_disponible: a.count > faltan,
          };
        });
      return {
        por_moneda: conDisponible(mergeAmounts([sap, maximo])),
        documentos: docs(sap) + docs(maximo),
        sin_subtotal: sinSubtotal,
        por_fuente: {
          sap: { documentos: docs(sap), por_moneda: sap },
          maximo: {
            documentos: docs(maximo),
            por_moneda: conDisponible(maximo),
            sin_subtotal: sinSubtotal,
          },
        },
      };
    };
    const capex = clas('CAPEX');
    const opex = clas('OPEX');
    const sinSubtotal = capex.sin_subtotal + opex.sin_subtotal;

    return {
      anio: year,
      ahorro: {
        // M1: disponible, documentos, por_moneda, por_fuente y por_comprador
        // salen de los mismos renglones
        ...ahorro,
        // K6: AB_AHORRO ya llega; sin dato = no se capturó en Maximo
        nota: 'SAP: U_Imp_ahorro por línea (captura de Compras desde 2026-09-15, incremental). Maximo: AB_AHORRO de la OC (solo las que lo tienen capturado).',
      },
      clasificacion: {
        disponible: capex.documentos + opex.documentos > 0,
        capex,
        opex,
        nota: `Montos sin IVA. SAP: U_Clas_gts por línea, con el importe de la línea (una OC con líneas CAPEX y OPEX cuenta en ambas). Maximo: AB_CLASFPO de la OC (solo las que lo tienen capturado), con su subtotal (suma de POLINE.LINECOST); ${
          sinSubtotal === 1
            ? '1 OC clasificada no tiene subtotal (sin líneas o con alguna sin LINECOST): cuenta en documentos, no en el monto'
            : `${sinSubtotal} OC clasificadas no tienen subtotal (sin líneas o con alguna sin LINECOST): cuentan en documentos, no en el monto`
        }.`,
      },
      // M2: días de G2 por comprador, por sistema; `total` = el del tablero
      gestion_por_comprador: gestionPorComprador,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * D3: fechas de las solicitudes base de las OC de G2 de SAP (segunda
   * vuelta); la misma para el tablero y Órdenes (M2).
   */
  private async sapGestionRequests(
    pos: SapGestionRow[],
  ): Promise<GestionPrRow[]> {
    const entries = [...new Set(pos.flatMap((po) => po.base_request_entries))];
    if (entries.length === 0) return [];
    return this.prisma.$queryRaw<GestionPrRow[]>(Prisma.sql`
      SELECT doc_entry, doc_date FROM sap_purchase_requests
      WHERE doc_entry IN (${Prisma.join(entries)})`);
  }

  /**
   * M2/E4: datos del comprador en Maximo de las OC de SAP que nacieron allá
   * (PONUM = `maximo_ponum`), de su última revisión, como en sap-records. La
   * que no existe en Maximo no sale (se queda con quien la capturó en SAP).
   */
  private async maximoBuyersByPonum(
    ponums: string[],
  ): Promise<MaximoPonumBuyerRow[]> {
    if (ponums.length === 0) return [];
    return this.prisma.$queryRaw<MaximoPonumBuyerRow[]>(Prisma.sql`
      SELECT DISTINCT ON (ponum) ponum, purchase_agent, purchase_agent_name, created_by
      FROM maximo_purchase_orders
      WHERE ponum IN (${Prisma.join(ponums)})
      ORDER BY ponum, coalesce(revisionnum, 0) DESC`);
  }

  /** Joi ya lo convirtió a boolean; se tolera el string por robustez. */
  private flag(name: string): boolean {
    const value = this.config.get<boolean | string>(name);
    return (
      value === true || (typeof value === 'string' && value.trim() === 'true')
    );
  }
}
