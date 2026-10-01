import { createHash, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MaximoContractDto } from '../dto/maximo-contract.dto';
import { MaximoPurchaseOrderDto } from '../dto/maximo-po.dto';
import { MAXIMO_MAPPER_VERSION, toCanonical } from '../maximo.mapper';
import { MaximoUpsertOutcome } from './maximo-sync.types';
import { poRequestColumns, replacePoStatusHistory } from './maximo-po-history';

/**
 * Upsert idempotente a staging (Fase INT-3, T3/T4). ÚNICO camino de escritura
 * a `maximo_purchase_orders` / `maximo_contracts`: lo usan el sync engine y el
 * seed de fixtures (T5) por igual.
 *
 * La clave natural es un índice único sobre expresiones coalesce (Prisma no lo
 * modela), así que el upsert va por findFirst + create/update; la carrera de
 * doble insert se resuelve capturando P2002 y reintentando como update
 * (patrón ya usado en enrollments/platforms).
 *
 * Sin-cambio (T4): mismo `rowstamp` (PO) / `contract_rowstamp` (contrato) →
 * solo se toca `last_seen_at`/`last_sync_run_id`. Cambio → se actualizan
 * columnas mapeadas + `raw` + `mapper_version` + `last_changed_at`.
 *
 * G6 (2026-09-28): el alta o el cambio de una OC reescribe su historial
 * POSTATUS (`maximo_po_status_history`) en la MISMA transacción.
 *
 * I9 (2026-09-30): el rowstamp es por fila en Maximo y NO cambia cuando CIISA
 * agrega campos a la Object Structure. Por eso "sin cambio" exige además el
 * mismo `raw_hash` (hash del payload recibido) y la misma versión del mapper:
 * un campo nuevo, o un mapper nuevo, reescribe `raw` y re-mapea la fila en el
 * siguiente full, sin pasos manuales (misma regla que el staging de SAP). El
 * hash va sobre la forma canónica: el mismo registro por legacy u OSLC no
 * cuenta como cambio.
 */
@Injectable()
export class MaximoStagingService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertPurchaseOrder(
    dto: MaximoPurchaseOrderDto,
    raw: unknown,
    runId: string,
  ): Promise<MaximoUpsertOutcome> {
    const rawHash = maximoRawHash(raw);
    // Normalización de la clave natural: el índice único usa coalesce(x, ''),
    // que colapsa NULL y '' en la misma tupla; aquí se normaliza '' → null
    // para que el espacio del findFirst coincida con el del índice y ninguna
    // representación alterna del mismo registro termine en P2002 permanente.
    const where = {
      ponum: dto.ponum,
      siteid: emptyToNull(dto.siteId),
      revisionnum: dto.revisionNum,
    };
    const mapped = {
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
      ...poRequestColumns(dto),
      rowstamp: dto.rowstamp,
      raw_hash: rawHash,
    };

    const attempt = async (): Promise<MaximoUpsertOutcome> => {
      const existing = await this.prisma.maximo_purchase_orders.findFirst({
        where,
        select: {
          id: true,
          rowstamp: true,
          raw_hash: true,
          mapper_version: true,
        },
      });
      if (!existing) {
        // id generado aquí para escribir OC + historial en una transacción
        const id = randomUUID();
        await this.prisma.$transaction([
          this.prisma.maximo_purchase_orders.create({
            data: {
              id,
              ...where,
              ...mapped,
              raw: raw as Prisma.InputJsonValue,
              mapper_version: MAXIMO_MAPPER_VERSION,
              last_sync_run_id: runId,
            },
          }),
          ...replacePoStatusHistory(this.prisma, id, dto),
        ]);
        return 'inserted';
      }
      const unchanged =
        existing.rowstamp !== null &&
        existing.rowstamp === dto.rowstamp &&
        existing.raw_hash === rawHash &&
        existing.mapper_version === MAXIMO_MAPPER_VERSION;
      if (unchanged) {
        await this.prisma.maximo_purchase_orders.update({
          where: { id: existing.id },
          data: { last_seen_at: new Date(), last_sync_run_id: runId },
        });
        return 'unchanged';
      }
      await this.prisma.$transaction([
        this.prisma.maximo_purchase_orders.update({
          where: { id: existing.id },
          data: {
            ...mapped,
            raw: raw as Prisma.InputJsonValue,
            mapper_version: MAXIMO_MAPPER_VERSION,
            last_seen_at: new Date(),
            last_changed_at: new Date(),
            last_sync_run_id: runId,
          },
        }),
        ...replacePoStatusHistory(this.prisma, existing.id, dto),
      ]);
      return 'updated';
    };

    return this.withUniqueRaceRetry(attempt);
  }

  async upsertContract(
    dto: MaximoContractDto,
    raw: unknown,
    runId: string,
  ): Promise<MaximoUpsertOutcome> {
    const rawHash = maximoRawHash(raw);
    // Ver nota de normalización en upsertPurchaseOrder ('' → null).
    const where = {
      prnum: emptyToNull(dto.prnum),
      contractnum: emptyToNull(dto.contractNum),
      revisionnum: dto.revisionNum,
    };
    const mapped = {
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
      pr_total: dto.prTotal, // D7: null si la OS no lo expone
      consumed_value: dto.consumedValue, // D8: null si la OS no lo expone
      purchview_count: dto.purchviewCount,
      has_contract: dto.hasContract,
      pr_rowstamp: dto.rowstamp,
      contract_rowstamp: dto.contractRowstamp,
      raw_hash: rawHash,
    };

    const attempt = async (): Promise<MaximoUpsertOutcome> => {
      const existing = await this.prisma.maximo_contracts.findFirst({
        where,
        select: {
          id: true,
          contract_rowstamp: true,
          pr_rowstamp: true,
          raw_hash: true,
          mapper_version: true,
        },
      });
      if (!existing) {
        await this.prisma.maximo_contracts.create({
          data: {
            ...where,
            ...mapped,
            raw: raw as Prisma.InputJsonValue,
            mapper_version: MAXIMO_MAPPER_VERSION,
            last_sync_run_id: runId,
          },
        });
        return 'inserted';
      }
      // T3: los cambios del contrato mutan la fila PURCHVIEW → contract_rowstamp.
      // PR SIN contrato (ambos null): se compara el rowstamp de la cabecera PR.
      const sameContractRow =
        existing.contract_rowstamp !== null &&
        existing.contract_rowstamp === dto.contractRowstamp;
      const bothWithoutContract =
        existing.contract_rowstamp === null && dto.contractRowstamp === null;
      const samePrRow =
        existing.pr_rowstamp !== null && existing.pr_rowstamp === dto.rowstamp;
      // I9: y el mismo payload con el mismo mapper
      const unchanged =
        (sameContractRow || (bothWithoutContract && samePrRow)) &&
        existing.raw_hash === rawHash &&
        existing.mapper_version === MAXIMO_MAPPER_VERSION;
      await this.prisma.maximo_contracts.update({
        where: { id: existing.id },
        data: unchanged
          ? { last_seen_at: new Date(), last_sync_run_id: runId }
          : {
              ...mapped,
              raw: raw as Prisma.InputJsonValue,
              mapper_version: MAXIMO_MAPPER_VERSION,
              last_seen_at: new Date(),
              last_changed_at: new Date(),
              last_sync_run_id: runId,
            },
      });
      return unchanged ? 'unchanged' : 'updated';
    };

    return this.withUniqueRaceRetry(attempt);
  }

  /** Carrera de doble insert (índice único de expresión) → P2002 → reintento. */
  private async withUniqueRaceRetry(
    attempt: () => Promise<MaximoUpsertOutcome>,
  ): Promise<MaximoUpsertOutcome> {
    try {
      return await attempt();
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'P2002') {
        // Otro proceso insertó la misma clave natural entre el findFirst y el
        // create: el reintento la encuentra y sigue por la rama de update.
        return attempt();
      }
      throw error;
    }
  }
}

/**
 * I9: hash del payload recibido sobre su forma canónica (claves en mayúsculas
 * y ordenadas, sin nulos): un campo o valor nuevo lo cambia; la forma de la
 * API (legacy anidado, legacy compacto u OSLC) no.
 */
export function maximoRawHash(raw: unknown): string {
  let payload: unknown;
  try {
    payload = stableForHash(toCanonical(raw));
  } catch {
    payload = raw;
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function stableForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableForHash);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== null) out[key] = stableForHash(item);
  }
  return out;
}

function toDate(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function emptyToNull(value: string | null): string | null {
  return value === '' ? null : value;
}
