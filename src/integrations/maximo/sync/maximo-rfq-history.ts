import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MaximoRfqDto } from '../dto/maximo-rfq.dto';

/**
 * O2 (2026-11-17) — Historial RFQSTATUS de cada RQ de Maximo
 * (`maximo_rfq_status_history`, migración 0023), con el patrón de
 * `maximo-po-history.ts`: por fila de staging (FK a `maximo_rfqs` con
 * cascada), ya ordenado por el mapper (CHANGEDATE ascendente, desempate
 * RFQSTATUSSEQ); `seq` conserva ese orden. Lo escriben staging (alta, cambio
 * y 'remapped') y remap, siempre reemplazando el historial completo de la RQ
 * en la misma transacción que la fila.
 */

export function rfqStatusHistoryRows(
  rfqId: string,
  dto: MaximoRfqDto,
): Prisma.maximo_rfq_status_historyCreateManyInput[] {
  return dto.statusHistory.map((change, seq) => ({
    rfq_id: rfqId,
    rfqnum: dto.rfqnum,
    siteid: emptyToNull(dto.siteId),
    seq,
    status: change.status,
    change_date: toDate(change.changeDate),
    changed_by: change.changedBy,
    memo: change.memo,
  }));
}

/** Operaciones para `$transaction([...])`: borra y vuelve a escribir. */
export function replaceRfqStatusHistory(
  prisma: PrismaService,
  rfqId: string,
  dto: MaximoRfqDto,
): Prisma.PrismaPromise<unknown>[] {
  const rows = rfqStatusHistoryRows(rfqId, dto);
  return [
    prisma.maximo_rfq_status_history.deleteMany({ where: { rfq_id: rfqId } }),
    ...(rows.length > 0
      ? [prisma.maximo_rfq_status_history.createMany({ data: rows })]
      : []),
  ];
}

/**
 * TODAS las columnas mapeadas de la RQ, en un solo lugar para staging y
 * remap. Sin `raw`, `raw_hash`, `mapper_version`, `superseded_at` ni las
 * columnas de auditoría del sync: esas las escribe cada camino.
 */
export function rfqMappedColumns(dto: MaximoRfqDto) {
  return {
    description: dto.description,
    status: dto.status,
    status_date: toDate(dto.statusDate),
    enter_date: toDate(dto.enterDate),
    enter_by: dto.enterBy,
    requested_by: dto.requestedBy,
    required_date: toDate(dto.requiredDate),
    closed_at: toDate(dto.closedDate),
    closed_by: dto.closedBy,
    cancelled_at: toDate(dto.cancelledDate),
    cancelled_by: dto.cancelledBy,
    po_nums: dto.poNums,
    rowstamp: dto.rowstamp,
  };
}

function toDate(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function emptyToNull(value: string | null): string | null {
  return value === '' ? null : value;
}
