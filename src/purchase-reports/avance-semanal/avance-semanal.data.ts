import { Prisma } from '@prisma/client';
import {
  CURRENT_MAXIMO_POS,
  CURRENT_MAXIMO_PRS,
  sapPoDuplicatedInMaximo,
} from '../../common/sql/erp-views.sql';
import type {
  AvanceData,
  Gestion,
  MaximoNoRecibida,
  OrdenMonto,
} from './avance-semanal.engine';
import { AVANCE_REGLAS, type AvanceReglas } from './avance-semanal.reglas';

/**
 * H1 — Carga de datos del reporte de avance semanal: TODO de una vez (unos
 * miles de filas) para que el acumulado de ~40 semanas no repita consultas.
 * Solo lectura; mismas reglas que el tablero:
 *  - SAP: solicitudes de pedido y su primera OC no cancelada por
 *    `base_request_entries` (G3); OC por moneda con `contada_en_maximo` (D1).
 *  - Maximo (K5, 2026-10-05): una fila por PR de `CURRENT_MAXIMO_PRS` con
 *    sus fechas reales de AB_CONTRATOS (K3: ISSUEDATE, primer APPR, último
 *    CLOSE y última CAN del historial PRSTATUS) y `de_contrato`; su OC por
 *    `pr_nums` de las OC vigentes no canceladas con fecha (`maximoFirstPo`).
 *    La recibida es el primer APPR o el ISSUEDATE según `reglas.recibida`;
 *    sin esa fecha la PR queda fuera del universo y se cuenta aparte, sin
 *    respaldo (ya no se ubica por folio ni por la fecha del contrato).
 *  - Montos (K6): las OC traen el total con IVA y el `subtotal` sin IVA
 *    (null = sin líneas o alguna sin importe).
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
  }>;
}

export async function loadAvanceRows(prisma: Queryable): Promise<AvanceRows> {
  const [
    sapRequests,
    sapFirstPo,
    sapOrders,
    maximoPrs,
    maximoFirstPo,
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
             s.subtotal,
             ${sapPoDuplicatedInMaximo('s')} AS contada_en_maximo
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
             p.total_cost AS monto, p.subtotal
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
    maximoOrders,
  };
}

const toNumber = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

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
    });
  }

  return {
    gestiones,
    ordenes,
    maximo_no_recibidas: noRecibidas,
    sap_desde: sapDesde,
  };
}
