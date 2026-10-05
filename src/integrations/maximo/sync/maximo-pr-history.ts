import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MaximoContractDto } from '../dto/maximo-contract.dto';

/**
 * K3 (2026-10-05) — Historial PRSTATUS de cada PR de Maximo
 * (`maximo_pr_status_history`, migración 0019), con el patrón de
 * `maximo-po-history.ts`. Es UNO por PR, sin FK: los campos de la PR se
 * repiten en cada revisión del contrato (`maximo_contracts` tiene una fila
 * por revisión), así que reescribir la misma PR una vez por revisión es
 * idempotente. El mapper ya lo entrega ordenado (CHANGEDATE ascendente,
 * desempate PRSTATUSID); `seq` conserva ese orden.
 *
 * Lo escriben staging (alta, cambio y 'remapped' del contrato, K8) dentro de
 * la misma transacción que la fila, y remap solo desde la fila vigente de
 * cada PR.
 */

export function prStatusHistoryRows(
  dto: MaximoContractDto,
): Prisma.maximo_pr_status_historyCreateManyInput[] {
  const prnum = emptyToNull(dto.prnum);
  if (prnum === null) return [];
  return dto.prStatusHistory.map((change, seq) => ({
    prnum,
    siteid: emptyToNull(dto.siteId),
    seq,
    status: change.status,
    change_date: toDate(change.changeDate),
    changed_by: change.changedBy,
    memo: change.memo,
  }));
}

/**
 * Operaciones para `$transaction([...])`: borra y vuelve a escribir el
 * historial de la PR. Sin prnum (raíz PURCHVIEW de la estructura previa) no
 * hay nada que escribir: `where: { prnum: null }` no aplica a esta tabla.
 */
export function replacePrStatusHistory(
  prisma: PrismaService,
  dto: MaximoContractDto,
): Prisma.PrismaPromise<unknown>[] {
  const prnum = emptyToNull(dto.prnum);
  if (prnum === null) return [];
  const rows = prStatusHistoryRows(dto);
  return [
    prisma.maximo_pr_status_history.deleteMany({ where: { prnum } }),
    ...(rows.length > 0
      ? [prisma.maximo_pr_status_history.createMany({ data: rows })]
      : []),
  ];
}

/**
 * K8 (2026-10-05): TODAS las columnas mapeadas del contrato (una fila por
 * revisión), en un solo lugar para staging y remap, incluidos los `pr_*` de
 * K3. Sin `superseded_at`: solo lo escriben las ramas de staging (remap no lo
 * toca). Sin `raw`, `raw_hash` ni `mapper_version`: los escribe cada camino.
 */
export function contractMappedColumns(dto: MaximoContractDto) {
  return {
    status: dto.status,
    maxvol: dto.maxVol,
    total_cost: dto.totalCost,
    currency: dto.currencyCode,
    start_date: toDate(dto.startDate),
    end_date: toDate(dto.endDate),
    vendor_id: dto.vendor?.company ?? null,
    vendor_name: dto.vendor?.name ?? null,
    requested_by: dto.requestedBy,
    department: dto.area,
    approved_at: toDate(dto.approvedDate),
    approved_by: dto.approvedBy,
    created_at_source: toDate(dto.createdDate),
    contract_ref_num: dto.contractRefNum, // §20.2 resuelta: = CONTRACTNUM
    contract_value: dto.contractValue, //   = TOTALCOST
    pr_total: dto.prTotal, // D7: PR.TOTALCOST de la raíz
    consumed_value: dto.consumedValue, // D8: null si la OS no lo expone
    purchview_count: dto.purchviewCount,
    has_contract: dto.hasContract,
    pr_rowstamp: dto.rowstamp,
    contract_rowstamp: dto.contractRowstamp,
    // K3: PR (raíz de AB_CONTRATOS), igual en todas las revisiones
    pr_status: dto.prStatus,
    pr_status_date: toDate(dto.prStatusDate),
    pr_issue_date: toDate(dto.prIssueDate),
    pr_approved_at: toDate(dto.prApprovedDate),
    pr_approved_by: dto.prApprovedBy,
    pr_closed_at: toDate(dto.prClosedDate),
    pr_cancelled_at: toDate(dto.prCancelledDate),
    pr_cancelled_by: dto.prCancelledBy,
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
