import { Prisma } from '@prisma/client';
import {
  CURRENT_MAXIMO_CONTRACTS,
  CURRENT_MAXIMO_POS,
  maximoPrFolio,
  sapPoDuplicatedInMaximo,
} from '../../common/sql/erp-views.sql';
import type {
  AvanceData,
  FechaOrigen,
  Gestion,
  OrdenMonto,
} from './avance-semanal.engine';

/**
 * H1 — Carga de datos del reporte de avance semanal: TODO de una vez (unos
 * miles de filas) para que el acumulado de ~40 semanas no repita consultas.
 * Solo lectura; mismas reglas que el tablero:
 *  - SAP: solicitudes de pedido y su primera OC no cancelada por
 *    `base_request_entries` (G3); OC por moneda con `contada_en_maximo` (D1).
 *  - Maximo: PR = filas de AB_CONTRATOS (`maximo_contracts`, vista vigente,
 *    igual que G3); su OC por `pr_nums` de las OC vigentes no canceladas.
 *
 * Fecha de las PR de Maximo (AB_CONTRATOS no manda ISSUEDATE):
 *  1. exacta: ISSUEDATE de la PR más antigua de una OC (`pr_issue_date`,
 *     0016) para el folio menor de esa OC — los mismos pares que G3;
 *  2. alta: la fecha en que la plataforma vio la PR por primera vez, si fue
 *     después de la carga inicial de la integración (sync cada hora) y no
 *     queda a más de 30 días de lo que dice su folio (una PR vieja que
 *     aparece tarde no se toma como nueva);
 *  3. folio: la fecha conocida más reciente de las PR con folio menor o
 *     igual (Maximo numera las PR en orden) — la misma ventana de G3;
 *  4. sin fecha: folio menor a todos los conocidos → fuera del reporte.
 */

type Queryable = {
  $queryRaw: <T>(query: Prisma.Sql) => Prisma.PrismaPromise<T>;
};

export interface AvanceRows {
  sapRequests: Array<{
    doc_entry: number;
    doc_num: number | null;
    doc_date: Date;
    document_status: string | null;
    cancelled: boolean | null;
    update_date_source: Date | null;
  }>;
  /** Primera OC no cancelada de cada solicitud de SAP. */
  sapFirstPo: Array<{ entry: number; primera_oc: Date }>;
  sapOrders: Array<{
    fecha: Date;
    moneda: string | null;
    monto: unknown;
    contada_en_maximo: boolean;
  }>;
  maximoPrs: Array<{
    prnum: string;
    con_contrato: boolean;
    fecha_contrato: Date | null;
    visto: Date | null;
  }>;
  /** Primera OC vigente no cancelada de cada PRNUM. */
  maximoFirstPo: Array<{ prnum: string; primera_oc: Date }>;
  /** Fechas conocidas: folio menor de cada OC con su PR.ISSUEDATE. */
  maximoKnown: Array<{ folio: unknown; fecha: Date }>;
  maximoOrders: Array<{ fecha: Date; moneda: string | null; monto: unknown }>;
}

export async function loadAvanceRows(prisma: Queryable): Promise<AvanceRows> {
  const [
    sapRequests,
    sapFirstPo,
    sapOrders,
    maximoPrs,
    maximoFirstPo,
    maximoKnown,
    maximoOrders,
  ] = await Promise.all([
    prisma.$queryRaw<AvanceRows['sapRequests']>(Prisma.sql`
      SELECT doc_entry, doc_num, doc_date, document_status, cancelled,
             update_date_source
      FROM sap_purchase_requests
      WHERE doc_date IS NOT NULL`),
    prisma.$queryRaw<AvanceRows['sapFirstPo']>(Prisma.sql`
      SELECT e AS entry, min(po.doc_date) AS primera_oc
      FROM sap_purchase_orders po, unnest(po.base_request_entries) AS e
      WHERE po.cancelled IS DISTINCT FROM true AND po.doc_date IS NOT NULL
      GROUP BY e`),
    prisma.$queryRaw<AvanceRows['sapOrders']>(Prisma.sql`
      SELECT s.doc_date AS fecha, s.currency AS moneda, s.doc_total AS monto,
             ${sapPoDuplicatedInMaximo('s')} AS contada_en_maximo
      FROM sap_purchase_orders s
      WHERE s.cancelled IS DISTINCT FROM true
        AND s.doc_date IS NOT NULL AND s.doc_total IS NOT NULL`),
    prisma.$queryRaw<AvanceRows['maximoPrs']>(Prisma.sql`
      SELECT c.prnum, bool_or(c.has_contract) AS con_contrato,
             min(c.created_at_source) FILTER (WHERE c.has_contract) AS fecha_contrato,
             min(c.first_seen_at) AS visto
      FROM (${CURRENT_MAXIMO_CONTRACTS}) c
      WHERE c.prnum IS NOT NULL
      GROUP BY c.prnum`),
    prisma.$queryRaw<AvanceRows['maximoFirstPo']>(Prisma.sql`
      SELECT f.prnum, min(p.created_at_source) AS primera_oc
      FROM (${CURRENT_MAXIMO_POS}) p, unnest(p.pr_nums) AS f(prnum)
      WHERE coalesce(p.status, '') NOT IN ('CAN', 'CANCEL')
        AND p.created_at_source IS NOT NULL
      GROUP BY f.prnum`),
    prisma.$queryRaw<AvanceRows['maximoKnown']>(Prisma.sql`
      WITH known AS (
        SELECT p.pr_issue_date AS fecha, min(${maximoPrFolio('f.prnum')}) AS folio
        FROM (${CURRENT_MAXIMO_POS}) p, unnest(p.pr_nums) AS f(prnum)
        WHERE p.pr_issue_date IS NOT NULL
        GROUP BY p.ponum, coalesce(p.siteid, ''), p.pr_issue_date
      )
      SELECT folio, min(fecha) AS fecha FROM known
      WHERE folio IS NOT NULL
      GROUP BY folio`),
    prisma.$queryRaw<AvanceRows['maximoOrders']>(Prisma.sql`
      SELECT p.created_at_source AS fecha, p.currency AS moneda, p.total_cost AS monto
      FROM (${CURRENT_MAXIMO_POS}) p
      WHERE coalesce(p.status, '') NOT IN ('CAN', 'CANCEL')
        AND p.created_at_source IS NOT NULL AND p.total_cost IS NOT NULL`),
  ]);
  return {
    sapRequests,
    sapFirstPo,
    sapOrders,
    maximoPrs,
    maximoFirstPo,
    maximoKnown,
    maximoOrders,
  };
}

const DAY_MS = 86_400_000;
/** Una PR vista por primera vez a más de esto de su fecha por folio es vieja. */
const ALTA_MAX_GAP_MS = 30 * DAY_MS;

/** Folio numérico de una PR (PR104531 → 104531), igual que `maximoPrFolio`. */
export function parseFolio(prnum: string): number | null {
  const digits = prnum.replace(/[^0-9]/g, '');
  return digits === '' ? null : Number(digits);
}

/**
 * Fecha aproximada por folio: la más reciente de las PR conocidas con folio
 * menor o igual. Equivale a la ventana de G3 (`loadMaximoPrFolioWindow`):
 * la PR cae en [desde, hasta) ⇔ su fecha aproximada cae ahí.
 */
export function maximoFolioDater(
  known: Array<{ folio: number; fecha: Date }>,
): (folio: number) => Date | null {
  const sorted = [...known].sort((a, b) => a.folio - b.folio);
  const folios = sorted.map((k) => k.folio);
  const latest: number[] = [];
  let max = Number.NEGATIVE_INFINITY;
  for (const k of sorted) {
    max = Math.max(max, k.fecha.getTime());
    latest.push(max);
  }
  return (folio: number) => {
    let lo = 0;
    let hi = folios.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (folios[mid] <= folio) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found < 0 ? null : new Date(latest[found]);
  };
}

const toNumber = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

/** Filas → gestiones y OC del motor (pura, para probarla con fixtures). */
export function buildAvanceData(rows: AvanceRows): AvanceData {
  const gestiones: Gestion[] = [];

  // SAP
  const sapFirstPo = new Map(
    rows.sapFirstPo.map((r) => [Number(r.entry), r.primera_oc]),
  );
  let sapDesde: Date | null = null;
  for (const r of rows.sapRequests) {
    const primeraOc = sapFirstPo.get(r.doc_entry) ?? null;
    const cancelled = r.cancelled === true;
    const closedByHand =
      !primeraOc && !cancelled && r.document_status === 'bost_Close';
    gestiones.push({
      sistema: 'sap',
      folio: String(r.doc_num ?? r.doc_entry),
      recibida: r.doc_date,
      fecha_origen: 'exacta',
      primera_oc: primeraOc,
      cierre_sin_oc: closedByHand ? (r.update_date_source ?? r.doc_date) : null,
      cancelada: cancelled ? (r.update_date_source ?? r.doc_date) : null,
    });
    if (!sapDesde || r.doc_date.getTime() < sapDesde.getTime()) {
      sapDesde = r.doc_date;
    }
  }

  // Maximo
  const known = rows.maximoKnown
    .map((k) => ({ folio: Number(k.folio), fecha: k.fecha }))
    .filter((k) => Number.isFinite(k.folio));
  const exact = new Map<number, Date>();
  for (const k of known) {
    const prev = exact.get(k.folio);
    if (!prev || k.fecha.getTime() < prev.getTime())
      exact.set(k.folio, k.fecha);
  }
  const byFolio = maximoFolioDater(known);
  const firstPo = new Map(
    rows.maximoFirstPo.map((r) => [r.prnum, r.primera_oc]),
  );
  const seen = rows.maximoPrs
    .map((r) => r.visto?.getTime())
    .filter((t): t is number => t !== undefined);
  // Carga inicial de la integración: lo visto ese día no dice cuándo nació
  const liveFrom = seen.length > 0 ? Math.min(...seen) + DAY_MS : Infinity;
  let sinFecha = 0;
  for (const r of rows.maximoPrs) {
    const folio = parseFolio(r.prnum);
    let recibida = folio === null ? null : (exact.get(folio) ?? null);
    let origen: FechaOrigen = 'exacta';
    if (!recibida) {
      const porFolio = folio === null ? null : byFolio(folio);
      const visto = r.visto?.getTime() ?? null;
      if (
        visto !== null &&
        visto > liveFrom &&
        (porFolio === null || visto - porFolio.getTime() <= ALTA_MAX_GAP_MS)
      ) {
        recibida = r.visto;
        origen = 'alta';
      } else if (porFolio) {
        recibida = porFolio;
        origen = 'folio';
      }
    }
    if (!recibida) {
      sinFecha += 1;
      continue;
    }
    gestiones.push({
      sistema: 'maximo',
      folio: r.prnum,
      recibida,
      fecha_origen: origen,
      primera_oc: firstPo.get(r.prnum) ?? null,
      // PR que se volvió contrato: cerrada (sin fecha del contrato → al recibirse)
      cierre_sin_oc: r.con_contrato ? (r.fecha_contrato ?? recibida) : null,
      cancelada: null,
    });
  }

  const ordenes: OrdenMonto[] = [];
  for (const o of rows.sapOrders) {
    const monto = toNumber(o.monto);
    if (monto === null) continue;
    ordenes.push({
      sistema: 'sap',
      fecha: o.fecha,
      moneda: o.moneda,
      monto,
      contada_en_maximo: o.contada_en_maximo === true,
    });
  }
  for (const o of rows.maximoOrders) {
    const monto = toNumber(o.monto);
    if (monto === null) continue;
    ordenes.push({
      sistema: 'maximo',
      fecha: o.fecha,
      moneda: o.moneda,
      monto,
      contada_en_maximo: false,
    });
  }

  return {
    gestiones,
    ordenes,
    maximo_sin_fecha: sinFecha,
    sap_desde: sapDesde,
  };
}
