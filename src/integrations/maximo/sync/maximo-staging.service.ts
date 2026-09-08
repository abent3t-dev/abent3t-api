import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MaximoContractDto } from '../dto/maximo-contract.dto';
import { MaximoPurchaseOrderDto } from '../dto/maximo-po.dto';
import { MAXIMO_MAPPER_VERSION } from '../maximo.mapper';
import { MaximoUpsertOutcome } from './maximo-sync.types';

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
 */
@Injectable()
export class MaximoStagingService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertPurchaseOrder(
    dto: MaximoPurchaseOrderDto,
    raw: unknown,
    runId: string,
  ): Promise<MaximoUpsertOutcome> {
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
      approved_at: toDate(dto.approvedDate),
      created_at_source: toDate(dto.orderDate),
      rowstamp: dto.rowstamp,
    };

    const attempt = async (): Promise<MaximoUpsertOutcome> => {
      const existing = await this.prisma.maximo_purchase_orders.findFirst({
        where,
        select: { id: true, rowstamp: true },
      });
      if (!existing) {
        await this.prisma.maximo_purchase_orders.create({
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
      const unchanged =
        existing.rowstamp !== null && existing.rowstamp === dto.rowstamp;
      await this.prisma.maximo_purchase_orders.update({
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

  async upsertContract(
    dto: MaximoContractDto,
    raw: unknown,
    runId: string,
  ): Promise<MaximoUpsertOutcome> {
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
      created_at_source: toDate(dto.createdDate),
      contract_ref_num: dto.contractRefNum, // §20.A.2: hoy siempre null
      contract_value: dto.contractValue, //   idem
      purchview_count: dto.purchviewCount,
      has_contract: dto.hasContract,
      pr_rowstamp: dto.rowstamp,
      contract_rowstamp: dto.contractRowstamp,
    };

    const attempt = async (): Promise<MaximoUpsertOutcome> => {
      const existing = await this.prisma.maximo_contracts.findFirst({
        where,
        select: { id: true, contract_rowstamp: true, pr_rowstamp: true },
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
      const unchanged = sameContractRow || (bothWithoutContract && samePrRow);
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

function toDate(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function emptyToNull(value: string | null): string | null {
  return value === '' ? null : value;
}
