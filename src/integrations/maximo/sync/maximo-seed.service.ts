import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../../../prisma/prisma.service';
import type { LoggerLike } from '../../common';
import { MAXIMO_LOGGER } from '../maximo.config';
import {
  MAXIMO_MAPPER_VERSION,
  parseLegacyEnvelope,
  parseOslcEnvelope,
  toContracts,
  toPurchaseOrder,
} from '../maximo.mapper';
import { MaximoStagingService } from './maximo-staging.service';
import { MaximoSeedProductionError } from './maximo-sync.errors';
import { MaximoSyncTarget, MaximoUpsertOutcome } from './maximo-sync.types';

/**
 * Seed de desarrollo (T5): carga los fixtures SANITIZADOS de Int-2 a staging
 * por EL MISMO camino de upsert del sync engine (`MaximoStagingService` — nada
 * de inserts directos), con corridas `maximo_sync_runs` reales marcadas
 * `triggered_by='seed'`.
 *
 * - Guard duro: `NODE_ENV=production` → `MaximoSeedProductionError` sin tocar
 *   la base. El seed NO exige `MAXIMO_SYNC_ENABLED` (no toca la red).
 * - Idempotente: la segunda ejecución termina con 0 inserted / 0 updated
 *   (todo `unchanged`). Nota: algunos fixtures traen el MISMO registro por
 *   dos APIs (PO102249 legacy y OSLC), así que ya en la primera corrida hay
 *   `unchanged` — es cobertura deliberada del camino de upsert.
 * - Propósito: Int-5 construye y verifica la UI con datos realistas sin
 *   conexión a Maximo; cuando haya conexión, el mismo flujo recibe datos
 *   reales. `maximo:seed-clear` retira lo sembrado.
 * - Solo dev/ts-node: los fixtures no se copian a `dist`.
 */

interface FixtureSpec {
  file: string;
  api: 'legacy' | 'oslc';
  os: 'AB_COMPRAS' | 'AB_CONTRATOS';
}

const PO_FIXTURES: FixtureSpec[] = [
  {
    file: 'ab-compras.legacy-nested.page.json',
    api: 'legacy',
    os: 'AB_COMPRAS',
  },
  {
    file: 'ab-compras.legacy-nested.ponum-filter.json',
    api: 'legacy',
    os: 'AB_COMPRAS',
  },
  {
    file: 'ab-compras.legacy-compact.po102249.json',
    api: 'legacy',
    os: 'AB_COMPRAS',
  },
  {
    file: 'ab-compras.legacy-compact.range.json',
    api: 'legacy',
    os: 'AB_COMPRAS',
  },
  { file: 'ab-compras.legacy.empty.json', api: 'legacy', os: 'AB_COMPRAS' },
  { file: 'ab-compras.oslc.po102249.json', api: 'oslc', os: 'AB_COMPRAS' },
  { file: 'ab-compras.oslc.range.json', api: 'oslc', os: 'AB_COMPRAS' },
  {
    file: 'ab-compras.oslc.page.SYNTHETIC.json',
    api: 'oslc',
    os: 'AB_COMPRAS',
  },
];

const CONTRACT_FIXTURES: FixtureSpec[] = [
  {
    file: 'ab-contratos.legacy-compact.pr102828.json',
    api: 'legacy',
    os: 'AB_CONTRATOS',
  },
  {
    file: 'ab-contratos.legacy-nested.no-contract.json',
    api: 'legacy',
    os: 'AB_CONTRATOS',
  },
  {
    file: 'ab-contratos.legacy-compact.purchview-root.v1.json',
    api: 'legacy',
    os: 'AB_CONTRATOS',
  },
  {
    file: 'ab-contratos.legacy-compact.wappr.SYNTHETIC.json',
    api: 'legacy',
    os: 'AB_CONTRATOS',
  },
  { file: 'ab-contratos.oslc.pr102828.json', api: 'oslc', os: 'AB_CONTRATOS' },
];
// Excluido a propósito: oslc.error.bmxaa8781e.json (sobre de error, sin registros).

export interface MaximoSeedTargetResult {
  target: MaximoSyncTarget;
  runId: string;
  fixtures: number;
  records: number;
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
}

export interface MaximoSeedResult {
  purchaseOrders: MaximoSeedTargetResult;
  contracts: MaximoSeedTargetResult;
}

@Injectable()
export class MaximoSeedService {
  private readonly logger: LoggerLike;

  constructor(
    private readonly prisma: PrismaService,
    private readonly staging: MaximoStagingService,
    @Optional() @Inject(MAXIMO_LOGGER) logger?: LoggerLike,
  ) {
    this.logger = logger ?? new Logger('Integration:maximo-seed');
  }

  async seedFixtures(): Promise<MaximoSeedResult> {
    this.assertNotProduction('maximo:seed-fixtures');
    const dir = this.fixturesDir();

    const purchaseOrders = await this.seedTarget(
      'purchase_orders',
      dir,
      PO_FIXTURES,
    );
    const contracts = await this.seedTarget(
      'contracts',
      dir,
      CONTRACT_FIXTURES,
    );
    return { purchaseOrders, contracts };
  }

  /** Borra las filas de staging cuyo last_sync_run_id pertenece a corridas seed. */
  async clearSeeds(): Promise<{ purchaseOrders: number; contracts: number }> {
    this.assertNotProduction('maximo:seed-clear');
    const seedRuns = await this.prisma.maximo_sync_runs.findMany({
      where: { triggered_by: 'seed' },
      select: { id: true },
    });
    const runIds = seedRuns.map((r) => r.id);
    if (runIds.length === 0) return { purchaseOrders: 0, contracts: 0 };

    // Nota: una fila sembrada que después tocó una corrida real (cron/manual)
    // tiene otro last_sync_run_id y se conserva — ya es dato "real".
    const pos = await this.prisma.maximo_purchase_orders.deleteMany({
      where: { last_sync_run_id: { in: runIds } },
    });
    const contracts = await this.prisma.maximo_contracts.deleteMany({
      where: { last_sync_run_id: { in: runIds } },
    });
    this.logger.log(
      `seed-clear: eliminadas ${pos.count} PO(s) y ${contracts.count} contrato(s) sembrados`,
    );
    return { purchaseOrders: pos.count, contracts: contracts.count };
  }

  // ---------------------------------------------------------------------------

  private assertNotProduction(operation: string): void {
    if (process.env.NODE_ENV === 'production') {
      throw new MaximoSeedProductionError(operation);
    }
  }

  private fixturesDir(): string {
    const dir = join(__dirname, '..', '__fixtures__');
    if (!existsSync(dir)) {
      throw new Error(
        `No existe ${dir} — el seed es solo dev/ts-node (los fixtures no se copian a dist)`,
      );
    }
    return dir;
  }

  private async seedTarget(
    target: MaximoSyncTarget,
    dir: string,
    fixtures: FixtureSpec[],
  ): Promise<MaximoSeedTargetResult> {
    const run = await this.prisma.maximo_sync_runs.create({
      data: {
        target,
        triggered_by: 'seed',
        mapper_version: MAXIMO_MAPPER_VERSION,
      },
      select: { id: true },
    });

    const result: MaximoSeedTargetResult = {
      target,
      runId: run.id,
      fixtures: fixtures.length,
      records: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
    };
    const errors: string[] = [];

    for (const spec of fixtures) {
      // Lectura/parseo dentro del try: un fixture ilegible cuenta como fallo
      // y la corrida SIEMPRE se finaliza (nunca queda `running`).
      let records: unknown[];
      try {
        const body = JSON.parse(
          readFileSync(join(dir, spec.file), 'utf8'),
        ) as unknown;
        records =
          spec.api === 'legacy'
            ? parseLegacyEnvelope(body, spec.os).records
            : parseOslcEnvelope(body).records;
      } catch (error: unknown) {
        result.failed += 1;
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${spec.file}: ${msg.slice(0, 200)}`);
        continue;
      }

      for (const raw of records) {
        result.records += 1;
        try {
          if (target === 'purchase_orders') {
            const dto = toPurchaseOrder(raw);
            this.count(
              result,
              await this.staging.upsertPurchaseOrder(dto, raw, run.id),
            );
          } else {
            for (const dto of toContracts(raw)) {
              this.count(
                result,
                await this.staging.upsertContract(dto, raw, run.id),
              );
            }
          }
        } catch (error: unknown) {
          result.failed += 1;
          const msg = error instanceof Error ? error.message : String(error);
          errors.push(`${spec.file}: ${msg.slice(0, 200)}`);
        }
      }
    }

    await this.prisma.maximo_sync_runs.update({
      where: { id: run.id },
      data: {
        finished_at: new Date(),
        status: result.failed > 0 ? 'partial' : 'success',
        pages_total: fixtures.length,
        pages_ok: fixtures.length,
        records_fetched: result.records,
        records_inserted: result.inserted,
        records_updated: result.updated,
        records_unchanged: result.unchanged,
        records_failed: result.failed,
        error_summary: errors.length ? errors.join(' | ').slice(0, 2000) : null,
      },
    });

    this.logger.log(
      `seed(${target}) corrida ${run.id}: fixtures=${result.fixtures} records=${result.records} inserted=${result.inserted} updated=${result.updated} unchanged=${result.unchanged} failed=${result.failed}`,
    );
    return result;
  }

  private count(
    result: MaximoSeedTargetResult,
    outcome: MaximoUpsertOutcome,
  ): void {
    if (outcome === 'inserted') result.inserted += 1;
    else if (outcome === 'updated') result.updated += 1;
    else result.unchanged += 1;
  }
}
