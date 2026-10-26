import { Prisma } from '@prisma/client';
import {
  CURRENT_MAXIMO_POS,
  CURRENT_MAXIMO_PRS,
  maximoPoDeContrato,
  maximoPoExchangeRate,
  sapPoDuplicatedInMaximo,
} from '../../common/sql/erp-views.sql';
import type {
  AvanceData,
  Gestion,
  MaximoNoRecibida,
  OrdenMonto,
  TiposCambio,
} from './avance-semanal.engine';
import { AVANCE_REGLAS, type AvanceReglas } from './avance-semanal.reglas';

/**
 * H1 — Carga de datos del reporte de avance semanal: TODO de una vez (unos
 * miles de filas) para que el acumulado de ~40 semanas no repita consultas.
 * Solo lectura; mismas reglas que el tablero:
 *  - SAP: solicitudes de pedido y su primera OC no cancelada por
 *    `base_request_entries` (G3); OC por moneda con `contada_en_maximo` (D1)
 *    y `copia_migrada` (las copias extra de la misma PO de Maximo).
 *  - Maximo (K5, 2026-10-05): una fila por PR de `CURRENT_MAXIMO_PRS` con
 *    sus fechas reales de AB_CONTRATOS (K3: ISSUEDATE, primer APPR, último
 *    CLOSE y última CAN del historial PRSTATUS) y `de_contrato`; su OC por
 *    `pr_nums` de las OC vigentes no canceladas con fecha (`maximoFirstPo`).
 *    La recibida es el primer APPR o el ISSUEDATE según `reglas.recibida`;
 *    sin esa fecha la PR queda fuera del universo y se cuenta aparte, sin
 *    respaldo (ya no se ubica por folio ni por la fecha del contrato).
 *  - Montos (K6): las OC traen el total con IVA y el `subtotal` sin IVA
 *    (null = sin líneas o alguna sin importe).
 *  - Festivos (H3, días hábiles): los activos de la tabla `holidays`, una
 *    vez, como 'YYYY-MM-DD'. El motor los usa solo con
 *    `reglas.dias_tipo='habiles'`; sin festivos, hábiles solo quita sábados
 *    y domingos.
 *  - O1 (2026-10-26): de cada OC de Maximo, si es de contrato
 *    (CONTRACTREFNUM) y su EXCHANGERATE (contra el dólar), leídos del `raw`
 *    (erp-views); de la copia en SAP de una OC de Maximo, si esa OC es de
 *    contrato. Tipos de cambio: pesos por dólar de cada día de Maximo (1 /
 *    el EXCHANGERATE promedio de sus OC en pesos de ese día) y el de
 *    referencia de SAP por moneda y mes (promedio de DocTotal / DocTotalFc).
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
    subtotal: unknown;
    contada_en_maximo: boolean;
    /**
     * Copia extra de la misma PO de Maximo (mismo `maximo_ponum`, no es la
     * de menor DocNum entre las no canceladas).
     */
    copia_migrada: boolean;
    /** O1: su OC de Maximo es de contrato (para `sap_migradas`). */
    de_contrato: boolean | null;
  }>;
  /** Una fila por PR (vista por PR, sin obsoletas). */
  maximoPrs: Array<{
    prnum: string;
    pr_status: string | null;
    pr_issue_date: Date | null;
    pr_approved_at: Date | null;
    pr_closed_at: Date | null;
    pr_cancelled_at: Date | null;
    de_contrato: boolean | null;
  }>;
  /** Primera OC vigente no cancelada (con fecha) de cada PRNUM. */
  maximoFirstPo: Array<{ prnum: string; primera_oc: Date }>;
  maximoOrders: Array<{
    fecha: Date;
    moneda: string | null;
    monto: unknown;
    subtotal: unknown;
    /** O1: CONTRACTREFNUM en la cabecera o en una línea. */
    de_contrato: boolean | null;
    /** O1: EXCHANGERATE de la OC, contra el dólar. */
    tc_usd: unknown;
  }>;
  /** H3: festivos activos de la tabla `holidays` ('YYYY-MM-DD'). */
  festivos: Array<{ dia: string }>;
  /**
   * O1: EXCHANGERATE promedio de las OC de Maximo en pesos de cada día
   * (hora de México, 'YYYY-MM-DD'): dólares por peso.
   */
  maximoTcDia: Array<{ dia: string; tc: unknown }>;
  /** O1: pesos por unidad de USD o EUR por mes ('YYYY-MM'), de SAP. */
  sapTcMes: Array<{ moneda: string; mes: string; tc: unknown }>;
}

/**
 * O1: un EXCHANGERATE de una OC en pesos fuera de este rango (de 2 a 100
 * pesos por dólar) es un error de captura y no entra al tipo del día.
 */
const TC_PESO_MIN = 0.01;
const TC_PESO_MAX = 0.5;

export async function loadAvanceRows(prisma: Queryable): Promise<AvanceRows> {
  const [
    sapRequests,
    sapFirstPo,
    sapOrders,
    maximoPrs,
    maximoFirstPo,
    maximoOrders,
    festivos,
    maximoTcDia,
    sapTcMes,
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
    // D1: la integración crea a veces varias OC no canceladas con el mismo
    // NumAtCard (PO103374: 9 copias del mismo total y fecha); se queda la de
    // menor DocNum (regla de Expeditación y de oc_sap) y las demás se marcan.
    // O1: si su OC de Maximo es de contrato (para `sap_migradas`)
    prisma.$queryRaw<AvanceRows['sapOrders']>(Prisma.sql`
      SELECT s.doc_date AS fecha, s.currency AS moneda, s.doc_total AS monto,
             s.subtotal,
             ${sapPoDuplicatedInMaximo('s')} AS contada_en_maximo,
             (s.maximo_ponum IS NOT NULL AND row_number() OVER (
                PARTITION BY s.maximo_ponum
                ORDER BY s.doc_num NULLS LAST, s.doc_entry) > 1) AS copia_migrada,
             (s.maximo_ponum IS NOT NULL AND EXISTS (
                SELECT 1 FROM (
                  -- la revisión vigente de su OC, como CURRENT_MAXIMO_POS
                  SELECT DISTINCT ON (coalesce(v.siteid, '')) v.raw
                  FROM maximo_purchase_orders v
                  WHERE v.ponum = s.maximo_ponum
                  ORDER BY coalesce(v.siteid, ''), coalesce(v.revisionnum, 0) DESC
                ) m
                WHERE ${maximoPoDeContrato('m')})) AS de_contrato
      FROM sap_purchase_orders s
      WHERE s.cancelled IS DISTINCT FROM true
        AND s.doc_date IS NOT NULL AND s.doc_total IS NOT NULL`),
    prisma.$queryRaw<AvanceRows['maximoPrs']>(Prisma.sql`
      SELECT p.prnum, p.pr_status, p.pr_issue_date, p.pr_approved_at,
             p.pr_closed_at, p.pr_cancelled_at, p.de_contrato
      FROM (${CURRENT_MAXIMO_PRS}) p`),
    prisma.$queryRaw<AvanceRows['maximoFirstPo']>(Prisma.sql`
      SELECT f.prnum, min(p.created_at_source) AS primera_oc
      FROM (${CURRENT_MAXIMO_POS}) p, unnest(p.pr_nums) AS f(prnum)
      WHERE coalesce(p.status, '') NOT IN ('CAN', 'CANCEL')
        AND p.created_at_source IS NOT NULL
      GROUP BY f.prnum`),
    prisma.$queryRaw<AvanceRows['maximoOrders']>(Prisma.sql`
      SELECT p.created_at_source AS fecha, p.currency AS moneda,
             p.total_cost AS monto, p.subtotal,
             ${maximoPoDeContrato('p')} AS de_contrato,
             ${maximoPoExchangeRate('p')} AS tc_usd
      FROM (${CURRENT_MAXIMO_POS}) p
      WHERE coalesce(p.status, '') NOT IN ('CAN', 'CANCEL')
        AND p.created_at_source IS NOT NULL AND p.total_cost IS NOT NULL`),
    // H3: `holiday_date` es @db.Date (sin hora): el texto evita corrimientos
    // de zona al pasarlo a Date
    prisma.$queryRaw<AvanceRows['festivos']>(Prisma.sql`
      SELECT to_char(h.holiday_date, 'YYYY-MM-DD') AS dia
      FROM holidays h
      WHERE h.is_active = true
      ORDER BY h.holiday_date`),
    // O1: el tipo del día sale de TODAS las OC en pesos con EXCHANGERATE
    // (también las canceladas y las de contrato: es un dato del día), por
    // día de México (UTC−6, como el corte del motor)
    prisma.$queryRaw<AvanceRows['maximoTcDia']>(Prisma.sql`
      SELECT to_char((p.created_at_source AT TIME ZONE 'UTC') - interval '6 hours',
                     'YYYY-MM-DD') AS dia,
             avg(t.tc)::float8 AS tc
      FROM (${CURRENT_MAXIMO_POS}) p
      CROSS JOIN LATERAL (SELECT ${maximoPoExchangeRate('p')} AS tc) t
      WHERE p.currency = 'MXN' AND p.created_at_source IS NOT NULL
        AND t.tc > ${TC_PESO_MIN} AND t.tc < ${TC_PESO_MAX}
      GROUP BY 1
      ORDER BY 1`),
    // O1: el de referencia de SAP, como en el diagnóstico del 20-oct:
    // promedio de DocTotal (pesos) / DocTotalFc (moneda de la OC) del mes
    prisma.$queryRaw<AvanceRows['sapTcMes']>(Prisma.sql`
      SELECT s.currency AS moneda,
             to_char(s.doc_date AT TIME ZONE 'UTC', 'YYYY-MM') AS mes,
             avg(t.total / t.fc)::float8 AS tc
      FROM sap_purchase_orders s
      CROSS JOIN LATERAL (
        SELECT NULLIF(s.raw::jsonb ->> 'DocTotal', '')::numeric AS total,
               NULLIF(s.raw::jsonb ->> 'DocTotalFc', '')::numeric AS fc) t
      WHERE s.currency IN ('USD', 'EUR') AND s.doc_date IS NOT NULL
        AND t.fc > 0 AND t.total > 0
      GROUP BY 1, 2`),
  ]);
  return {
    sapRequests,
    sapFirstPo,
    sapOrders,
    maximoPrs,
    maximoFirstPo,
    maximoOrders,
    festivos,
    maximoTcDia,
    sapTcMes,
  };
}

const toNumber = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

/**
 * O1: los tipos de cambio del motor. Pesos por dólar del día = 1 / el
 * EXCHANGERATE promedio de las OC en pesos (dólares por peso); el de SAP ya
 * viene en pesos por unidad. Sin filas (dev, o antes del 26-oct) → vacíos.
 */
export function tiposDeCambio(
  maximoTcDia: AvanceRows['maximoTcDia'] = [],
  sapTcMes: AvanceRows['sapTcMes'] = [],
): TiposCambio {
  const maximo_dia = maximoTcDia
    .map((r) => ({ dia: r.dia, tc: toNumber(r.tc) }))
    .filter((r): r is { dia: string; tc: number } => !!r.tc && r.tc > 0)
    .map((r) => ({ dia: r.dia, mxn_por_usd: 1 / r.tc }))
    .sort((a, b) => a.dia.localeCompare(b.dia));
  const sap_mes: Record<string, number> = {};
  for (const r of sapTcMes) {
    const tc = toNumber(r.tc);
    if (tc && tc > 0) sap_mes[`${r.moneda}|${r.mes}`] = tc;
  }
  return { maximo_dia, sap_mes };
}

/**
 * Filas → gestiones y OC del motor (pura, para probarla con fixtures). Con
 * `reglas.recibida`/`reglas.dias_desde` (default = AVANCE_REGLAS) elige la
 * recibida y el inicio de los días de las PR de Maximo; el motor debe
 * armar la página con las mismas reglas.
 */
export function buildAvanceData(
  rows: AvanceRows,
  reglas: AvanceReglas = AVANCE_REGLAS,
): AvanceData {
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
      fecha_origen: 'documento',
      inicio_dias: r.doc_date,
      primera_oc: primeraOc,
      cierre_sin_oc: closedByHand ? (r.update_date_source ?? r.doc_date) : null,
      cancelada: cancelled ? (r.update_date_source ?? r.doc_date) : null,
      de_contrato: false,
    });
    if (!sapDesde || r.doc_date.getTime() < sapDesde.getTime()) {
      sapDesde = r.doc_date;
    }
  }

  // Maximo (K5): fechas reales de la PR, sin respaldo
  const firstPo = new Map(
    rows.maximoFirstPo.map((r) => [r.prnum, r.primera_oc]),
  );
  const fechaDe = (
    r: AvanceRows['maximoPrs'][number],
    inicio: AvanceReglas['recibida'],
  ) => (inicio === 'aprobacion' ? r.pr_approved_at : r.pr_issue_date);
  const noRecibidas: MaximoNoRecibida[] = [];
  for (const r of rows.maximoPrs) {
    const recibida = fechaDe(r, reglas.recibida);
    if (!recibida) {
      noRecibidas.push({
        prnum: r.prnum,
        emision: r.pr_issue_date,
        pr_status: r.pr_status,
      });
      continue;
    }
    // cerrada = coalesce(primera OC, último CLOSE); cancelada = última CAN
    const primeraOc = firstPo.get(r.prnum) ?? null;
    gestiones.push({
      sistema: 'maximo',
      folio: r.prnum,
      recibida,
      fecha_origen: reglas.recibida,
      inicio_dias: fechaDe(r, reglas.dias_desde),
      primera_oc: primeraOc,
      cierre_sin_oc: primeraOc ? null : r.pr_closed_at,
      cancelada: r.pr_cancelled_at,
      de_contrato: r.de_contrato === true,
      // H6: para contarla como no recibida en las semanas antes de su APPR
      emision: r.pr_issue_date,
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
      subtotal: toNumber(o.subtotal),
      contada_en_maximo: o.contada_en_maximo === true,
      copia_migrada: o.copia_migrada === true,
      de_contrato: o.de_contrato === true,
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
      subtotal: toNumber(o.subtotal),
      contada_en_maximo: false,
      de_contrato: o.de_contrato === true,
      tc_usd: toNumber(o.tc_usd),
    });
  }

  return {
    gestiones,
    ordenes,
    maximo_no_recibidas: noRecibidas,
    sap_desde: sapDesde,
    festivos: rows.festivos.map((f) => f.dia),
    tipos_cambio: tiposDeCambio(rows.maximoTcDia, rows.sapTcMes),
  };
}
