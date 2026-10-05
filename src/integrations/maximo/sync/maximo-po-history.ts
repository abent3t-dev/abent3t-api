import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MaximoPurchaseOrderDto } from '../dto/maximo-po.dto';

/**
 * G6 (2026-09-28) — Historial POSTATUS persistido por fila de staging
 * (`maximo_po_status_history`, migración 0016). El mapper ya lo entrega
 * ordenado (CHANGEDATE ascendente, desempate POSTATUSID); `seq` conserva ese
 * orden. Lo escriben staging (alta, cambio y 'remapped' de la OC, K8) y
 * remap, siempre reemplazando el historial completo de la fila dentro de la
 * misma transacción que actualiza la OC.
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
 * K8 (2026-10-05): TODAS las columnas mapeadas de la OC, en un solo lugar
 * (antes se repetían en staging y en remap). Las usan staging (alta, cambio y
 * 'remapped') y remap por igual. No incluye `raw`, `raw_hash`,
 * `mapper_version` ni las columnas de auditoría del sync: esas las escribe
 * cada camino.
 */
export function poMappedColumns(dto: MaximoPurchaseOrderDto) {
  return {
    status: dto.status,
    description: dto.description,
    vendor_id: dto.vendor?.company ?? null,
    vendor_name: dto.vendor?.name ?? null,
    total_cost: dto.totalCost,
    currency: dto.currencyCode,
    ab_ahorro: dto.abAhorro,
    ab_tipocomp: dto.abTipoComp,
    ab_clasfpo: dto.abClasfPo,
    requested_by: dto.requestedBy,
    department: dto.area,
    purchase_agent: dto.purchaseAgent,
    purchase_agent_name: dto.purchaseAgentName,
    created_by: dto.createdBy,
    approved_at: toDate(dto.approvedDate),
    approved_by: dto.approvedBy,
    waiting_approval_at: toDate(dto.waitingApprovalDate),
    created_at_source: toDate(dto.orderDate),
    // G2/G3: PR de las líneas; I1b: recepción
    pr_issue_date: toDate(dto.prIssueDate),
    pr_nums: dto.prNums,
    receipt_status: dto.receiptStatus,
    // K2: PO5 literal; K6: Σ LINECOST sin IVA (null si falta en alguna línea)
    integration_status: dto.integrationStatus,
    subtotal: dto.subtotal,
    rowstamp: dto.rowstamp,
  };
}

function toDate(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}
