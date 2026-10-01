import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MaximoPurchaseOrderDto } from '../dto/maximo-po.dto';

/**
 * G6 (2026-09-28) — Historial POSTATUS persistido por fila de staging
 * (`maximo_po_status_history`, migración 0016). El mapper ya lo entrega
 * ordenado (CHANGEDATE ascendente, desempate POSTATUSID); `seq` conserva ese
 * orden. Lo escriben staging (alta/cambio de la OC) y remap, siempre
 * reemplazando el historial completo de la fila dentro de la misma
 * transacción que actualiza la OC.
 */

export function poStatusHistoryRows(
  poId: string,
  dto: MaximoPurchaseOrderDto,
): Prisma.maximo_po_status_historyCreateManyInput[] {
  return dto.statusHistory.flatMap((change, seq) =>
    change.status === null
      ? []
      : [
          {
            po_id: poId,
            ponum: dto.ponum,
            siteid: dto.siteId === '' ? null : dto.siteId,
            revisionnum: dto.revisionNum,
            seq,
            status: change.status,
            change_date: toDate(change.changeDate),
            changed_by: change.changedBy,
          },
        ],
  );
}

/** Operaciones para `$transaction([...])`: borra y vuelve a escribir. */
export function replacePoStatusHistory(
  prisma: PrismaService,
  poId: string,
  dto: MaximoPurchaseOrderDto,
): Prisma.PrismaPromise<unknown>[] {
  const rows = poStatusHistoryRows(poId, dto);
  return [
    prisma.maximo_po_status_history.deleteMany({ where: { po_id: poId } }),
    ...(rows.length > 0
      ? [prisma.maximo_po_status_history.createMany({ data: rows })]
      : []),
  ];
}

/**
 * Columnas de la OC derivadas de sus líneas: PR (G2/G3) y recepción (I1b).
 * Las usan staging y remap por igual.
 */
export function poRequestColumns(dto: MaximoPurchaseOrderDto) {
  return {
    pr_issue_date: toDate(dto.prIssueDate),
    pr_nums: dto.prNums,
    receipt_status: dto.receiptStatus,
  };
}

function toDate(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}
