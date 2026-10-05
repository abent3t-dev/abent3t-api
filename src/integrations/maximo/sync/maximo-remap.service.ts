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
import { poMappedColumns, replacePoStatusHistory } from './maximo-po-history';
import {
  contractMappedColumns,
  replacePrStatusHistory,
} from './maximo-pr-history';
import { maximoRawHash } from './maximo-staging.service';

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

/** K8: lo que hace falta para elegir la fila vigente de cada PR. */
interface ContractCandidate {
  id: string;
  prnum: string | null;
  has_contract: boolean;
  revisionnum: number | null;
  last_seen_at: Date | null;
  superseded_at: Date | null;
}

/**
 * Re-mapeo sin red (Fase INT-3): re-ejecuta el mapper de Int-2 sobre el `raw`
 * JSONB de cada fila de staging y actualiza las columnas mapeadas +
 * `mapper_version`. Es el retorno de inversión del `raw`: basta cambiar el
 * mapper y correr `npm run maximo:remap`, sin re-descargar nada de Maximo.
 *
 * NO depende de `MaximoClient`: cero llamadas de red por construcción.
 * G6 (2026-09-28): también reescribe el historial POSTATUS de cada OC.
 *
 * K8 (2026-10-05): queda para dev y emergencias; en un deploy el primer full
 * del sync re-mapea como 'remapped' sin pasos manuales.
 *   - Usa las mismas funciones de columnas que staging (`poMappedColumns`,
 *     `contractMappedColumns`) y recalcula `raw_hash` con el hash estable.
 *   - No toca `raw`, `first_seen_at`, `last_seen_at`, `last_changed_at`,
 *     `last_sync_run_id` ni `superseded_at` (ese solo lo escribe el sync).
 *   - Escribe el historial PRSTATUS de cada PR SOLO desde su fila vigente
 *     (mismo orden que `CURRENT_MAXIMO_PRS`: no obsoleta, con contrato, la
 *     revisión más alta y la más reciente), no desde la última que recorre:
 *     el recorrido va por `id`, un uuid al azar.
 *   - No correrlo con una corrida del sync en curso: el delete + createMany
 *     del historial concurrente choca con el UNIQUE (prnum, seq).
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
          await this.prisma.$transaction([
            this.prisma.maximo_purchase_orders.update({
              where: { id: row.id },
              data: {
                ...poMappedColumns(dto),
                raw_hash: maximoRawHash(row.raw),
                mapper_version: MAXIMO_MAPPER_VERSION,
              },
            }),
            ...replacePoStatusHistory(this.prisma, row.id, dto),
          ]);
          result.remapped += 1;
        } catch (error: unknown) {
          this.recordFailure(result, row.id, error);
        }
      }
    }
  }

  private async remapContracts(result: MaximoRemapResult): Promise<void> {
    const currentByPr = await this.currentRowByPr();
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
          // con la fila (con la misma normalización '' → null de staging).
          const dtos = toContracts(row.raw);
          const dto =
            dtos.length === 1
              ? dtos[0]
              : (dtos.find(
                  (d) =>
                    emptyToNull(d.contractNum) === row.contractnum &&
                    d.revisionNum === row.revisionnum &&
                    emptyToNull(d.prnum) === row.prnum,
                ) ?? null);
          if (!dto) {
            throw new Error(
              `el raw ya no contiene la revisión (contractnum=${row.contractnum ?? '-'}, revisionnum=${row.revisionnum ?? '-'})`,
            );
          }
          const isCurrent =
            row.prnum !== null && currentByPr.get(row.prnum) === row.id;
          await this.prisma.$transaction([
            this.prisma.maximo_contracts.update({
              where: { id: row.id },
              data: {
                ...contractMappedColumns(dto),
                raw_hash: maximoRawHash(row.raw),
                mapper_version: MAXIMO_MAPPER_VERSION,
              },
            }),
            // K8: historial de la PR solo desde su fila vigente
            ...(isCurrent ? replacePrStatusHistory(this.prisma, dto) : []),
          ]);
          result.remapped += 1;
        } catch (error: unknown) {
          this.recordFailure(result, row.id, error);
        }
      }
    }
  }

  /**
   * K8: id de la fila vigente de cada PR, con el orden de `CURRENT_MAXIMO_PRS`
   * entre las no obsoletas: `has_contract` desc, `revisionnum` desc (null =
   * 0), `last_seen_at` desc. En JS y sin SQL crudo (precarga sin `raw`).
   */
  private async currentRowByPr(): Promise<Map<string, string>> {
    const candidates: ContractCandidate[] =
      await this.prisma.maximo_contracts.findMany({
        select: {
          id: true,
          prnum: true,
          has_contract: true,
          revisionnum: true,
          last_seen_at: true,
          superseded_at: true,
        },
      });
    const best = new Map<string, ContractCandidate>();
    for (const row of candidates) {
      // `== null`: en el testkit una fila sin el campo trae undefined
      if (row.prnum === null || row.superseded_at != null) continue;
      const current = best.get(row.prnum);
      if (!current || ranksBefore(row, current)) best.set(row.prnum, row);
    }
    return new Map([...best].map(([prnum, row]) => [prnum, row.id]));
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

/** true si `a` va antes que `b` en el orden de CURRENT_MAXIMO_PRS. */
function ranksBefore(a: ContractCandidate, b: ContractCandidate): boolean {
  if (a.has_contract !== b.has_contract) return a.has_contract;
  const revA = a.revisionnum ?? 0;
  const revB = b.revisionnum ?? 0;
  if (revA !== revB) return revA > revB;
  return timeOf(a.last_seen_at) > timeOf(b.last_seen_at);
}

function timeOf(value: Date | null): number {
  return value ? value.getTime() : Number.NEGATIVE_INFINITY;
}

function emptyToNull(value: string | null): string | null {
  return value === '' ? null : value;
}
