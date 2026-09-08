import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type { LoggerLike } from '../../common';
import { MAXIMO_LOGGER } from '../maximo.config';
import {
  MAXIMO_MAPPER_VERSION,
  toContracts,
  toPurchaseOrder,
} from '../maximo.mapper';
import { MaximoSyncTarget } from './maximo-sync.types';

export interface MaximoRemapResult {
  target: MaximoSyncTarget;
  mapperVersion: string;
  scanned: number;
  remapped: number;
  failed: number;
  errors: string[];
}

const BATCH_SIZE = 200;
const MAX_ERRORS = 20;

/**
 * Re-mapeo sin red (Fase INT-3): re-ejecuta el mapper de Int-2 sobre el `raw`
 * JSONB de cada fila de staging y actualiza las columnas mapeadas +
 * `mapper_version`. Es el retorno de inversión del `raw`: cuando Isaac
 * confirme equivalencias (§20.A.2/7), basta cambiar el mapper y correr
 * `npm run maximo:remap` — sin re-descargar nada de Maximo.
 *
 * NO depende de `MaximoClient`: cero llamadas de red por construcción.
 * No toca `raw`, `first_seen_at`, `last_seen_at` ni `last_sync_run_id`.
 */
@Injectable()
export class MaximoRemapService {
  private readonly logger: LoggerLike;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(MAXIMO_LOGGER) logger?: LoggerLike,
  ) {
    this.logger = logger ?? new Logger('Integration:maximo-remap');
  }

  async remapAll(target: MaximoSyncTarget): Promise<MaximoRemapResult> {
    const result: MaximoRemapResult = {
      target,
      mapperVersion: MAXIMO_MAPPER_VERSION,
      scanned: 0,
      remapped: 0,
      failed: 0,
      errors: [],
    };
    if (target === 'purchase_orders') await this.remapPurchaseOrders(result);
    else await this.remapContracts(result);

    this.logger.log(
      `remapAll(${target}) → mapper ${MAXIMO_MAPPER_VERSION}: scanned=${result.scanned} remapped=${result.remapped} failed=${result.failed}`,
    );
    return result;
  }

  private async remapPurchaseOrders(result: MaximoRemapResult): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const rows: Array<{ id: string; raw: unknown }> =
        await this.prisma.maximo_purchase_orders.findMany({
          take: BATCH_SIZE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: { id: 'asc' },
          select: { id: true, raw: true },
        });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      for (const row of rows) {
        result.scanned += 1;
        try {
          const dto = toPurchaseOrder(row.raw);
          await this.prisma.maximo_purchase_orders.update({
            where: { id: row.id },
            data: {
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
              mapper_version: MAXIMO_MAPPER_VERSION,
            },
          });
          result.remapped += 1;
        } catch (error: unknown) {
          this.recordFailure(result, row.id, error);
        }
      }
    }
  }

  private async remapContracts(result: MaximoRemapResult): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const rows: Array<{
        id: string;
        raw: unknown;
        prnum: string | null;
        contractnum: string | null;
        revisionnum: number | null;
      }> = await this.prisma.maximo_contracts.findMany({
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          raw: true,
          prnum: true,
          contractnum: true,
          revisionnum: true,
        },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      for (const row of rows) {
        result.scanned += 1;
        try {
          // El raw guarda el registro PR completo (todas las revisiones, T3):
          // se re-mapea todo y se elige el DTO cuya clave natural coincide
          // con la fila.
          const dtos = toContracts(row.raw);
          const dto =
            dtos.length === 1
              ? dtos[0]
              : (dtos.find(
                  (d) =>
                    d.contractNum === row.contractnum &&
                    d.revisionNum === row.revisionnum &&
                    d.prnum === row.prnum,
                ) ?? null);
          if (!dto) {
            throw new Error(
              `el raw ya no contiene la revisión (contractnum=${row.contractnum ?? '-'}, revisionnum=${row.revisionnum ?? '-'})`,
            );
          }
          await this.prisma.maximo_contracts.update({
            where: { id: row.id },
            data: {
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
              contract_ref_num: dto.contractRefNum,
              contract_value: dto.contractValue,
              purchview_count: dto.purchviewCount,
              has_contract: dto.hasContract,
              pr_rowstamp: dto.rowstamp,
              contract_rowstamp: dto.contractRowstamp,
              mapper_version: MAXIMO_MAPPER_VERSION,
            },
          });
          result.remapped += 1;
        } catch (error: unknown) {
          this.recordFailure(result, row.id, error);
        }
      }
    }
  }

  private recordFailure(
    result: MaximoRemapResult,
    rowId: string,
    error: unknown,
  ): void {
    result.failed += 1;
    if (result.errors.length < MAX_ERRORS) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(`${rowId}: ${msg.slice(0, 200)}`);
    }
  }
}

function toDate(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}
