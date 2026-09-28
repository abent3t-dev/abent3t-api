import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  andMaximoPrInWindow,
  CURRENT_MAXIMO_CONTRACTS,
  loadMaximoPrFolioWindow,
  maximoPrWithoutPo,
} from '../common/sql/erp-views.sql';

/**
 * G3 (reunión con Ingrid 2026-09-28) — "Pendientes de gestionar" = RQ
 * creada que todavía no tiene OC (misma idea que la gestión de G2: la RQ
 * cierra su gestión cuando nace su OC).
 *
 *  - SAP: solicitudes de pedido abiertas y no canceladas que ninguna OC no
 *    cancelada usa como base (`base_request_entries`).
 *  - Maximo: PR sin contrato cuyo PRNUM no aparece en ninguna OC vigente no
 *    cancelada (`pr_nums`, 0016). AB_CONTRATOS no expone la fecha de la PR:
 *    el periodo se ubica por folio (Maximo numera las PR en orden) contra las
 *    fechas conocidas por las OC. Sin fechas conocidas → null ("No disponible").
 *
 * Periodo: el año elegido o, sin año, los últimos 12 meses (las PR
 * históricas nunca cerradas inflarían el número). `sin_limite` = el conteo
 * sin periodo, para el tooltip.
 */

export interface PendingRequests {
  sap: { pendientes: number; sin_limite: number };
  maximo: { pendientes: number | null; sin_limite: number };
  /** Periodo aplicado (YYYY-MM-DD); `hasta` null = hasta hoy. */
  desde: string;
  hasta: string | null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function loadPendingRequests(
  prisma: PrismaService,
  from: Date,
  toExcl: Date | null,
): Promise<PendingRequests> {
  const window = await loadMaximoPrFolioWindow(prisma, from, toExcl);
  const sapUntil = toExcl ? Prisma.sql`AND doc_date < ${toExcl}` : Prisma.empty;
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
    prisma.$queryRaw<
      Array<{ pendientes: number; sin_limite: number }>
    >(Prisma.sql`
      WITH current AS (${CURRENT_MAXIMO_CONTRACTS})
      SELECT count(*) FILTER (WHERE true ${andMaximoPrInWindow('c', window)})::int AS pendientes,
             count(*)::int AS sin_limite
      FROM current c
      WHERE ${maximoPrWithoutPo('c')}`),
  ]);
  return {
    sap: {
      pendientes: Number(sap[0]?.pendientes ?? 0),
      sin_limite: Number(sap[0]?.sin_limite ?? 0),
    },
    maximo: {
      // sin fechas conocidas (p. ej. antes del remap) no se puede ubicar
      pendientes:
        window.lower === null ? null : Number(maximo[0]?.pendientes ?? 0),
      sin_limite: Number(maximo[0]?.sin_limite ?? 0),
    },
    desde: isoDay(from),
    hasta: toExcl ? isoDay(new Date(toExcl.getTime() - 1)) : null,
  };
}
