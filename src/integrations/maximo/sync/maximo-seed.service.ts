import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../../../prisma/prisma.service';
import type { LoggerLike } from '../../common';
import { MaximoContractDto } from '../dto/maximo-contract.dto';
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
import { MaximoSyncTarget, MaximoUpsertResult } from './maximo-sync.types';

/**
 * Seed de desarrollo (T5): carga los fixtures SANITIZADOS de Int-2 a staging
 * por EL MISMO camino de upsert del sync engine (`MaximoStagingService` — nada
 * de inserts directos), con corridas `maximo_sync_runs` reales marcadas
 * `triggered_by='seed'`.
 *
 * - Guard duro: `NODE_ENV=production` → `MaximoSeedProductionError` sin tocar
 *   la base. El seed NO exige `MAXIMO_SYNC_ENABLED` (no toca la red).
 * - Idempotente: la segunda ejecución termina con 0 inserted / 0 updated /
 *   0 remapped (todo `unchanged`). Nota: algunos fixtures traen el MISMO
 *   registro por dos APIs o dos formas (PO102249 legacy y OSLC; las PR
 *   prstatus anidada y compacta), así que ya en la primera corrida hay
 *   `unchanged` — es cobertura deliberada del camino de upsert.
 * - K8: como el sync, cuenta 'remapped' aparte y marca las revisiones
 *   obsoletas de cada PR (`supersedeMissingRevisions`, `superseded` en el
 *   resultado y en el log).
 * - No pisa datos reales (bloque K): una OC o una PR que ya tiene alguna fila
 *   de una corrida real (cron/manual, o sin corrida) se salta completa y se
 *   cuenta en `skipped`. Si no, el upsert reescribiría esa fila (y
 *   `clearSeeds` la borraría, porque quedaría con la corrida seed),
 *   `supersedeMissingRevisions` marcaría sus revisiones reales como obsoletas
 *   y su historial (POSTATUS/PRSTATUS) quedaría con el del fixture, sin forma
 *   de deshacerlo en el clear.
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
  // K2/K6 (2026-10-05): PO104896 con PO5, LINECOST y líneas desordenadas
  {
    file: 'ab-compras.legacy-nested.po5-linecost.SYNTHETIC.json',
    api: 'legacy',
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
  // K3 (2026-10-05): PR990001..PR990007 con STATUS, fechas e historial
  // PRSTATUS. Las dos formas dan el mismo canónico: la segunda sale
  // 'unchanged' (cobertura del camino de upsert, como PO102249).
  {
    file: 'ab-contratos.legacy-nested.prstatus.SYNTHETIC.json',
    api: 'legacy',
    os: 'AB_CONTRATOS',
  },
  {
    file: 'ab-contratos.legacy-compact.prstatus.SYNTHETIC.json',
    api: 'legacy',
    os: 'AB_CONTRATOS',
  },
];
// Excluido a propósito: oslc.error.bmxaa8781e.json (sobre de error, sin registros).

export interface MaximoSeedTargetResult {
  target: MaximoSyncTarget;
  runId: string;
  fixtures: number;
  records: number;
  inserted: number;
  updated: number;
  /** K8: mismo rowstamp re-mapeado (mapper o hash nuevos). */
  remapped: number;
  unchanged: number;
  failed: number;
  /** Registros que no se tocaron porque su OC o su PR ya tiene datos reales. */
  skipped: number;
  /** K8: revisiones marcadas obsoletas (`superseded_at`); solo contratos. */
  superseded: number;
}

/** Llaves de ejemplo de los registros saltados en el log de la corrida. */
const SKIPPED_SAMPLE_KEYS = 5;

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

  /**
   * Borra las filas de staging cuyo last_sync_run_id pertenece a corridas
   * seed. K3: el historial PRSTATUS no tiene FK (es por PR), así que se borra
   * aparte por prnum, solo de las PR que ya no conservan ninguna fila.
   */
  async clearSeeds(): Promise<{
    purchaseOrders: number;
    contracts: number;
    prStatusHistory: number;
  }> {
    this.assertNotProduction('maximo:seed-clear');
    const seedRuns = await this.prisma.maximo_sync_runs.findMany({
      where: { triggered_by: 'seed' },
      select: { id: true },
    });
    const runIds = seedRuns.map((r) => r.id);
    if (runIds.length === 0) {
      return { purchaseOrders: 0, contracts: 0, prStatusHistory: 0 };
    }

    // Nota: una fila sembrada que después tocó una corrida real (cron/manual)
    // tiene otro last_sync_run_id y se conserva — ya es dato "real".
    const pos = await this.prisma.maximo_purchase_orders.deleteMany({
      where: { last_sync_run_id: { in: runIds } },
    });
    const seededPrs = await this.prisma.maximo_contracts.findMany({
      where: { last_sync_run_id: { in: runIds } },
      select: { prnum: true },
    });
    const contracts = await this.prisma.maximo_contracts.deleteMany({
      where: { last_sync_run_id: { in: runIds } },
    });
    const prnums = [
      ...new Set(
        seededPrs
          .map((r) => r.prnum)
          .filter((p): p is string => p !== null && p !== ''),
      ),
    ];
    let historyCount = 0;
    if (prnums.length > 0) {
      // Una PR con alguna revisión tocada por una corrida real conserva su
      // historial, igual que esa fila.
      const kept = await this.prisma.maximo_contracts.findMany({
        where: { prnum: { in: prnums } },
        select: { prnum: true },
      });
      const keptPrs = new Set(kept.map((r) => r.prnum));
      const orphan = prnums.filter((p) => !keptPrs.has(p));
      if (orphan.length > 0) {
        const history = await this.prisma.maximo_pr_status_history.deleteMany({
          where: { prnum: { in: orphan } },
        });
        historyCount = history.count;
      }
    }
    this.logger.log(
      `seed-clear: eliminadas ${pos.count} PO(s), ${contracts.count} contrato(s) y ${historyCount} cambio(s) de historial de PR sembrados`,
    );
    return {
      purchaseOrders: pos.count,
      contracts: contracts.count,
      prStatusHistory: historyCount,
    };
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
      remapped: 0,
      unchanged: 0,
      failed: 0,
      skipped: 0,
      superseded: 0,
    };
    const errors: string[] = [];
    const skippedKeys: string[] = [];
    // Todas las corridas seed (incluida esta): una fila de cualquiera de
    // ellas es del seed; cualquier otra es dato real y no se toca.
    const seedRuns = await this.prisma.maximo_sync_runs.findMany({
      where: { triggered_by: 'seed' },
      select: { id: true },
    });
    const seedRunIds = new Set(seedRuns.map((r) => r.id));
    const skip = (key: string): void => {
      result.skipped += 1;
      if (skippedKeys.length < SKIPPED_SAMPLE_KEYS) skippedKeys.push(key);
    };

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
            if (await this.poHasRealRows(dto.ponum, seedRunIds)) {
              skip(dto.ponum);
              continue;
            }
            this.count(
              result,
              await this.staging.upsertPurchaseOrder(dto, raw, run.id),
            );
          } else {
            const dtos = toContracts(raw);
            const realKey = await this.contractRealKey(dtos, seedRunIds);
            if (realKey !== null) {
              skip(realKey);
              continue;
            }
            for (const dto of dtos) {
              this.count(
                result,
                await this.staging.upsertContract(dto, raw, run.id),
              );
            }
            // K8: igual que el sync, solo si todas las revisiones del
            // registro quedaron escritas (un fallo salta al catch).
            result.superseded += await this.staging.supersedeMissingRevisions(
              dtos[0]?.prnum ?? null,
              dtos,
            );
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
        records_remapped: result.remapped,
        records_unchanged: result.unchanged,
        records_failed: result.failed,
        error_summary: errors.length ? errors.join(' | ').slice(0, 2000) : null,
      },
    });

    // skipped y (en contratos) superseded van siempre, también en 0, como en
    // el log del sync: un 0 explícito se distingue de un dato que no se midió.
    const skippedSample =
      skippedKeys.length > 0
        ? ` (con datos reales, no se tocaron; ej.: ${skippedKeys.join(', ')})`
        : '';
    const superseded =
      target === 'contracts' ? ` superseded=${result.superseded}` : '';
    this.logger.log(
      `seed(${target}) corrida ${run.id}: fixtures=${result.fixtures} records=${result.records} inserted=${result.inserted} updated=${result.updated} remapped=${result.remapped} unchanged=${result.unchanged} failed=${result.failed} skipped=${result.skipped}${skippedSample}${superseded}`,
    );
    return result;
  }

  /** true si la OC tiene alguna fila que no es de una corrida seed. */
  private async poHasRealRows(
    ponum: string,
    seedRunIds: ReadonlySet<string>,
  ): Promise<boolean> {
    const rows = await this.prisma.maximo_purchase_orders.findMany({
      where: { ponum },
      select: { last_sync_run_id: true },
    });
    return rows.some((r) => !isSeedRow(r.last_sync_run_id, seedRunIds));
  }

  /**
   * Llave de la PR (o del contrato, si el registro no trae PR) que ya tiene
   * alguna fila que no es de una corrida seed; null si todo es del seed. Se
   * revisa la PR completa, no solo las revisiones del fixture: la marca de
   * obsoletas y el historial PRSTATUS son por PR.
   */
  private async contractRealKey(
    dtos: MaximoContractDto[],
    seedRunIds: ReadonlySet<string>,
  ): Promise<string | null> {
    const prnum = dtos[0]?.prnum ?? null;
    if (prnum !== null && prnum !== '') {
      const rows = await this.prisma.maximo_contracts.findMany({
        where: { prnum },
        select: { last_sync_run_id: true },
      });
      return rows.some((r) => !isSeedRow(r.last_sync_run_id, seedRunIds))
        ? prnum
        : null;
    }
    // Sin PR (raíz PURCHVIEW de la estructura previa): por contrato
    for (const dto of dtos) {
      const contractnum = dto.contractNum === '' ? null : dto.contractNum;
      if (contractnum === null) continue;
      const rows = await this.prisma.maximo_contracts.findMany({
        where: { prnum: null, contractnum },
        select: { last_sync_run_id: true },
      });
      if (rows.some((r) => !isSeedRow(r.last_sync_run_id, seedRunIds))) {
        return contractnum;
      }
    }
    return null;
  }

  private count(
    result: MaximoSeedTargetResult,
    { outcome }: MaximoUpsertResult,
  ): void {
    if (outcome === 'inserted') result.inserted += 1;
    else if (outcome === 'updated') result.updated += 1;
    // K8: antes un desenlace nuevo caía en silencio a unchanged
    else if (outcome === 'remapped') result.remapped += 1;
    else result.unchanged += 1;
  }
}

/** Fila escrita por una corrida seed (sin corrida = dato real o manual). */
function isSeedRow(
  runId: string | null | undefined,
  seedRunIds: ReadonlySet<string>,
): boolean {
  return runId !== null && runId !== undefined && seedRunIds.has(runId);
}
