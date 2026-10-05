import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  andBetween,
  CURRENT_MAXIMO_PRS,
  maximoContractPrPending,
  maximoPrApprovedWithPo,
  maximoPrInApproval,
  maximoPrLlegada,
  maximoPrPending,
} from '../common/sql/erp-views.sql';

/**
 * G3 (reunión con Ingrid 2026-09-28) — "Pendientes de gestionar" = RQ que
 * todavía no tiene OC (misma idea que la gestión de G2: la RQ cierra su
 * gestión cuando nace su OC).
 *
 *  - SAP: solicitudes de pedido abiertas y no canceladas que ninguna OC no
 *    cancelada usa como base (`base_request_entries`).
 *  - Maximo (K4, 2026-10-05): PR APROBADAS (APPR: ya llegaron a Compras) sin
 *    contrato y sin OC vigente no cancelada (`maximoPrPending`), contadas por
 *    PR sobre `CURRENT_MAXIMO_PRS`. El periodo va por la llegada a Compras
 *    (`maximoPrLlegada`, primer APPR). Antes se ubicaban por folio y
 *    entraban las CAN y CLOSE sin OC. Si ninguna PR tiene `pr_status` (antes
 *    del primer full con el mapper de K3) → null ("No disponible"), nunca 0.
 *
 * Periodo: el año elegido o, sin año, los últimos 12 meses (las PR
 * históricas nunca cerradas inflarían el número). `sin_limite` = el conteo
 * sin periodo, para el tooltip.
 *
 * Aparte, sin sumarse a los pendientes (Maximo, mismo periodo):
 *  - I8 (go-live 2026-09-30) `de_contrato`: APPR de contrato sin OC (la OC se
 *    genera en automático);
 *  - `aprobadas_con_oc`: APPR que ya tienen OC, con o sin contrato (dato).
 *    pendientes + de_contrato + aprobadas_con_oc = las APPR del periodo;
 *  - `en_aprobacion`: WAPPR (todavía no llegan a Compras), por su emisión
 *    (`pr_issue_date`).
 */

export interface PendingRequests {
  sap: { pendientes: number; sin_limite: number };
  maximo: {
    pendientes: number | null;
    sin_limite: number;
    /** I8: APPR de contrato sin OC del periodo (fuera de la carga de Compras). */
    de_contrato: number | null;
    de_contrato_sin_limite: number;
    /** K4: APPR que ya tienen OC (con o sin contrato), solo como dato. */
    aprobadas_con_oc: number | null;
    aprobadas_con_oc_sin_limite: number;
    /** K4: WAPPR del periodo por su emisión; aparte, no se suman. */
    en_aprobacion: number | null;
    en_aprobacion_sin_limite: number;
  };
  /** Periodo aplicado (YYYY-MM-DD); `hasta` null = hasta hoy. */
  desde: string;
  hasta: string | null;
}

type MaximoPendingRow = {
  pendientes: number;
  sin_limite: number;
  de_contrato: number;
  de_contrato_sin_limite: number;
  aprobadas_con_oc: number;
  aprobadas_con_oc_sin_limite: number;
  en_aprobacion: number;
  en_aprobacion_sin_limite: number;
  con_estatus: number;
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function loadPendingRequests(
  prisma: PrismaService,
  from: Date,
  toExcl: Date | null,
): Promise<PendingRequests> {
  const sapUntil = toExcl ? Prisma.sql`AND doc_date < ${toExcl}` : Prisma.empty;
  // K4: APPR por su llegada a Compras; WAPPR por su emisión
  const llegada = andBetween(maximoPrLlegada('p'), from, toExcl);
  const emision = andBetween(Prisma.sql`p.pr_issue_date`, from, toExcl);
  const [sap, maximo] = await Promise.all([
    prisma.$queryRaw<
      Array<{ pendientes: number; sin_limite: number }>
    >(Prisma.sql`
      SELECT count(*) FILTER (WHERE doc_date >= ${from} ${sapUntil})::int AS pendientes,
             count(*)::int AS sin_limite
      FROM sap_purchase_requests
      WHERE document_status = 'bost_Open' AND cancelled IS DISTINCT FROM true
        AND doc_entry NOT IN (
          SELECT unnest(base_request_entries) FROM sap_purchase_orders
          WHERE cancelled IS DISTINCT FROM true)`),
    prisma.$queryRaw<MaximoPendingRow[]>(Prisma.sql`
      WITH prs AS (${CURRENT_MAXIMO_PRS})
      SELECT count(DISTINCT p.prnum) FILTER (WHERE ${maximoPrPending('p')} ${llegada})::int AS pendientes,
             count(DISTINCT p.prnum) FILTER (WHERE ${maximoPrPending('p')})::int AS sin_limite,
             count(DISTINCT p.prnum) FILTER (WHERE ${maximoContractPrPending('p')} ${llegada})::int AS de_contrato,
             count(DISTINCT p.prnum) FILTER (WHERE ${maximoContractPrPending('p')})::int AS de_contrato_sin_limite,
             count(DISTINCT p.prnum) FILTER (WHERE ${maximoPrApprovedWithPo('p')} ${llegada})::int AS aprobadas_con_oc,
             count(DISTINCT p.prnum) FILTER (WHERE ${maximoPrApprovedWithPo('p')})::int AS aprobadas_con_oc_sin_limite,
             count(DISTINCT p.prnum) FILTER (WHERE ${maximoPrInApproval('p')} ${emision})::int AS en_aprobacion,
             count(DISTINCT p.prnum) FILTER (WHERE ${maximoPrInApproval('p')})::int AS en_aprobacion_sin_limite,
             count(*) FILTER (WHERE p.pr_status IS NOT NULL)::int AS con_estatus
      FROM prs p`),
  ]);
  const m = maximo[0];
  // sin pr_status en ninguna PR (antes del primer full) no hay base
  const conBase = Number(m?.con_estatus ?? 0) > 0;
  const enPeriodo = (value: number | undefined) =>
    conBase ? Number(value ?? 0) : null;
  return {
    sap: {
      pendientes: Number(sap[0]?.pendientes ?? 0),
      sin_limite: Number(sap[0]?.sin_limite ?? 0),
    },
    maximo: {
      pendientes: enPeriodo(m?.pendientes),
      sin_limite: Number(m?.sin_limite ?? 0),
      de_contrato: enPeriodo(m?.de_contrato),
      de_contrato_sin_limite: Number(m?.de_contrato_sin_limite ?? 0),
      aprobadas_con_oc: enPeriodo(m?.aprobadas_con_oc),
      aprobadas_con_oc_sin_limite: Number(m?.aprobadas_con_oc_sin_limite ?? 0),
      en_aprobacion: enPeriodo(m?.en_aprobacion),
      en_aprobacion_sin_limite: Number(m?.en_aprobacion_sin_limite ?? 0),
    },
    desde: isoDay(from),
    hasta: toExcl ? isoDay(new Date(toExcl.getTime() - 1)) : null,
  };
}
