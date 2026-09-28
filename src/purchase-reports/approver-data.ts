import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  MaximoHistoryApproval,
  SapApprovalDoc,
  SapApprovalLine,
} from './approver-stats';

/**
 * G5/G6 (2026-09-28) — Lecturas para los tiempos por aprobador (ver
 * approver-stats.ts, que tiene la regla). Una sola consulta por fuente.
 */

/** Cola de autorización de SAP completa (unos cientos de documentos). */
export async function loadSapApprovalDocs(
  prisma: PrismaService,
): Promise<SapApprovalDoc[]> {
  const rows = await prisma.sap_approval_requests.findMany({
    select: {
      code: true,
      status: true,
      current_stage: true,
      creation_date: true,
      approvers: true,
    },
  });
  return rows.map((row) => ({
    code: row.code,
    status: row.status,
    current_stage: row.current_stage,
    creation_date: row.creation_date,
    approvers: Array.isArray(row.approvers)
      ? (row.approvers as unknown as SapApprovalLine[])
      : [],
  }));
}

/**
 * Aprobaciones del historial POSTATUS de Maximo (APPRn / APPR / APPRnREV /
 * REVISD) con la fecha del cambio inmediato anterior = cuando le llegó.
 * `period` acota por la fecha de la aprobación (sin periodo = todo).
 */
export async function loadMaximoApprovals(
  prisma: PrismaService,
  period: { from: Date; to: Date } | null = null,
): Promise<MaximoHistoryApproval[]> {
  const inPeriod = period
    ? Prisma.sql`AND change_date BETWEEN ${period.from} AND ${period.to}`
    : Prisma.empty;
  return prisma.$queryRaw<MaximoHistoryApproval[]>(Prisma.sql`
    SELECT status, changed_by, change_date, prev_date
    FROM (
      SELECT h.status, h.changed_by, h.change_date,
             lag(h.change_date) OVER (PARTITION BY h.po_id ORDER BY h.seq) AS prev_date
      FROM maximo_po_status_history h
    ) t
    WHERE status ~ '^(APPR[0-9]*(REV)?|REVISD)$' ${inPeriod}`);
}

/**
 * G6: quién hace la SIGUIENTE aprobación después de cada estatus en
 * aprobación (WAPPR → APPR1 o APPR…, APPR1 → APPR2…): los aprobadores
 * habituales de lo que hoy espera en ese estatus.
 */
export async function loadMaximoNextApprovers(
  prisma: PrismaService,
): Promise<Array<{ desde: string; usuario: string; veces: number }>> {
  const rows = await prisma.$queryRaw<
    Array<{ desde: string; usuario: string; veces: number }>
  >(Prisma.sql`
    SELECT prev_status AS desde, changed_by AS usuario, count(*)::int AS veces
    FROM (
      SELECT h.status, h.changed_by,
             lag(h.status) OVER (PARTITION BY h.po_id ORDER BY h.seq) AS prev_status
      FROM maximo_po_status_history h
    ) t
    WHERE status ~ '^(APPR[0-9]*(REV)?|REVISD)$'
      AND prev_status ~ '^(WAPPR|APPR[0-9]+(REV)?)$'
      AND changed_by IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, 3 DESC`);
  return rows.map((r) => ({ ...r, veces: Number(r.veces) }));
}
