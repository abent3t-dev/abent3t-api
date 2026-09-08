import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type { LoggerLike } from '../../common';
import { MAXIMO_CONFIG, MAXIMO_LOGGER } from '../maximo.config';
import type { MaximoConfig } from '../maximo.config';
import { MaximoClient } from '../maximo.client';
import type { MaximoFetchResult } from '../maximo.client';
import { MAXIMO_MAPPER_VERSION, toContracts } from '../maximo.mapper';
import { MaximoStagingService } from './maximo-staging.service';
import { MAXIMO_SYNC_CONFIG } from './maximo-sync.config';
import type { MaximoSyncConfig } from './maximo-sync.config';
import {
  MaximoSyncDisabledError,
  MaximoSyncInProgressError,
} from './maximo-sync.errors';
import {
  MaximoSyncCounters,
  MaximoSyncRunStatus,
  MaximoSyncRunSummary,
  MaximoSyncSkipped,
  MaximoSyncTarget,
  MaximoSyncTrigger,
} from './maximo-sync.types';

/**
 * Motor de sincronización Maximo → staging (Fase INT-3).
 *
 * SOLO LECTURA hacia Maximo: el único camino HTTP es `MaximoClient` (Int-2)
 * sobre `IntegrationHttpClient` (Int-1). Escribe únicamente en NUESTRA base
 * (staging) vía `MaximoStagingService`.
 *
 * - T4: full scan paginado legacy (`_maxItems`/`_rsStart`, validado en prod);
 *   upsert idempotente con skip por rowstamp sin cambio.
 * - Tolerancia a fallo por página: la página que falla se registra y la
 *   corrida continúa; `partial` si hubo fallos, `failed` si NINGUNA página
 *   se procesó.
 * - Mutex in-memory por target (una instancia de API): corrida solapada del
 *   mismo target → `MaximoSyncInProgressError`; targets distintos concurren.
 * - `MAXIMO_SYNC_ENABLED=false` → `MaximoSyncDisabledError` sin tocar la red
 *   (el gate del cron vive en el scheduler; este es el gate de servicio).
 * - Contratos con `MAXIMO_CONTRACTS_ENABLED=false` → skip con log informativo
 *   (sin corrida, sin error).
 */

const MAX_PAGES_GUARD = 1_000;
const ERROR_ITEM_MAX_CHARS = 300;
const ERROR_SUMMARY_MAX_CHARS = 2_000;
/** Con fallos consecutivos y sin total conocido, corta el escaneo. */
const MAX_CONSECUTIVE_PAGE_FAILURES = 3;

interface RunState extends MaximoSyncCounters {
  runId: string;
  target: MaximoSyncTarget;
  triggeredBy: MaximoSyncTrigger;
  filterWarnings: unknown[];
  errors: string[];
}

/** Corridas `running` más viejas que esto se consideran zombies al arrancar. */
const STALE_RUN_THRESHOLD_MS = 30 * 60_000;

@Injectable()
export class MaximoSyncService implements OnModuleInit {
  private readonly logger: LoggerLike;
  private readonly running = new Set<MaximoSyncTarget>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MaximoClient,
    private readonly staging: MaximoStagingService,
    @Inject(MAXIMO_SYNC_CONFIG) private readonly syncConfig: MaximoSyncConfig,
    @Inject(MAXIMO_CONFIG) private readonly maximoConfig: MaximoConfig,
    @Optional() @Inject(MAXIMO_LOGGER) logger?: LoggerLike,
  ) {
    this.logger = logger ?? new Logger('Integration:maximo-sync');
  }

  /**
   * Limpieza de zombies al arrancar (mismo patrón que platform_sync_logs):
   * el mutex es in-memory, así que tras un crash/redeploy una corrida puede
   * quedar `running` para siempre en la bitácora. Se marca `failed`.
   */
  async onModuleInit(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - STALE_RUN_THRESHOLD_MS);
      const stale = await this.prisma.maximo_sync_runs.updateMany({
        where: { status: 'running', started_at: { lt: cutoff } },
        data: {
          status: 'failed',
          finished_at: new Date(),
          error_summary:
            'Marcada como fallida al reiniciar el servidor (zombie cleanup)',
        },
      });
      if (stale.count > 0) {
        this.logger.warn(
          `zombie cleanup: ${stale.count} corrida(s) 'running' marcadas como failed al arrancar`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(`zombie cleanup falló al arrancar: ${message(error)}`);
    }
  }

  isRunning(target: MaximoSyncTarget): boolean {
    return this.running.has(target);
  }

  /** Corrida completa de AB_COMPRAS (espera a que termine). */
  async syncPurchaseOrders(
    trigger: MaximoSyncTrigger,
    userId: string | null = null,
  ): Promise<MaximoSyncRunSummary> {
    const state = await this.beginRun('purchase_orders', trigger, userId);
    return this.processPurchaseOrders(state);
  }

  /** Corrida completa de AB_CONTRATOS, o skip si el flag está apagado. */
  async syncContracts(
    trigger: MaximoSyncTrigger,
    userId: string | null = null,
  ): Promise<MaximoSyncRunSummary | MaximoSyncSkipped> {
    const skipped = this.contractsSkip();
    if (skipped) return skipped;
    const state = await this.beginRun('contracts', trigger, userId);
    return this.processContracts(state);
  }

  /**
   * Disparo asíncrono (POST /integrations/maximo/sync): crea la corrida y
   * devuelve su id de inmediato; el procesamiento sigue en background
   * (fire-and-forget, mismo patrón que el sync de Crehana).
   */
  async startPurchaseOrders(
    trigger: MaximoSyncTrigger,
    userId: string | null,
  ): Promise<string> {
    const state = await this.beginRun('purchase_orders', trigger, userId);
    void this.processPurchaseOrders(state).catch((error: unknown) =>
      this.failRunBestEffort(state, error),
    );
    return state.runId;
  }

  async startContracts(
    trigger: MaximoSyncTrigger,
    userId: string | null,
  ): Promise<string | MaximoSyncSkipped> {
    const skipped = this.contractsSkip();
    if (skipped) return skipped;
    const state = await this.beginRun('contracts', trigger, userId);
    void this.processContracts(state).catch((error: unknown) =>
      this.failRunBestEffort(state, error),
    );
    return state.runId;
  }

  /** Fire-and-forget: si el procesamiento revienta, la fila no queda `running`. */
  private async failRunBestEffort(
    state: RunState,
    error: unknown,
  ): Promise<void> {
    this.logger.error(
      `Corrida ${state.runId} (${state.target}) terminó con error inesperado: ${message(error)}`,
    );
    try {
      await this.prisma.maximo_sync_runs.update({
        where: { id: state.runId },
        data: {
          status: 'failed',
          finished_at: new Date(),
          error_summary: message(error).slice(0, ERROR_SUMMARY_MAX_CHARS),
        },
      });
    } catch {
      // best-effort: el zombie cleanup del arranque la recogerá.
    }
  }

  // ---------------------------------------------------------------------------
  // Núcleo
  // ---------------------------------------------------------------------------

  private contractsSkip(): MaximoSyncSkipped | null {
    if (this.maximoConfig.contractsEnabled) return null;
    const reason =
      'AB_CONTRATOS deshabilitada (MAXIMO_CONTRACTS_ENABLED=false, §20.A.2) — corrida omitida';
    this.logger.log(reason);
    return { skipped: true, target: 'contracts', reason };
  }

  /** Gate por flag + mutex + fila `running` en maximo_sync_runs. */
  private async beginRun(
    target: MaximoSyncTarget,
    triggeredBy: MaximoSyncTrigger,
    userId: string | null,
  ): Promise<RunState> {
    if (!this.syncConfig.enabled && triggeredBy !== 'seed') {
      throw new MaximoSyncDisabledError();
    }
    if (this.running.has(target)) {
      throw new MaximoSyncInProgressError(target);
    }
    this.running.add(target);
    try {
      const run = await this.prisma.maximo_sync_runs.create({
        data: {
          target,
          triggered_by: triggeredBy,
          triggered_by_user_id: userId,
          mapper_version: MAXIMO_MAPPER_VERSION,
        },
        select: { id: true },
      });
      return {
        runId: run.id,
        target,
        triggeredBy,
        pagesTotal: null,
        pagesOk: 0,
        pagesFailed: 0,
        recordsFetched: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        recordsUnchanged: 0,
        recordsFailed: 0,
        filterWarnings: [],
        errors: [],
      };
    } catch (error) {
      this.running.delete(target);
      throw error;
    }
  }

  private async processPurchaseOrders(
    state: RunState,
  ): Promise<MaximoSyncRunSummary> {
    return this.paginate(state, async (rsStart, pageSize) => {
      const page = await this.client.fetchPurchaseOrders({
        maxItems: pageSize,
        rsStart,
      });
      for (let i = 0; i < page.records.length; i++) {
        await this.upsertOne(state, () =>
          this.staging.upsertPurchaseOrder(
            page.records[i],
            page.raw[i],
            state.runId,
          ),
        );
      }
      return page;
    });
  }

  private async processContracts(
    state: RunState,
  ): Promise<MaximoSyncRunSummary> {
    return this.paginate(state, async (rsStart, pageSize) => {
      const page = await this.client.fetchContracts({
        maxItems: pageSize,
        rsStart,
      });
      // T3: una fila de staging por revisión (PURCHVIEW). El DTO de
      // page.records trae solo la revisión vigente; aquí se re-mapea el crudo
      // con toContracts para obtener TODAS.
      for (const raw of page.raw) {
        let dtos;
        try {
          dtos = toContracts(raw);
        } catch (error: unknown) {
          state.recordsFailed += 1;
          this.pushError(state, `mapeo de contrato: ${message(error)}`);
          continue;
        }
        for (const dto of dtos) {
          await this.upsertOne(state, () =>
            this.staging.upsertContract(dto, raw, state.runId),
          );
        }
      }
      return page;
    });
  }

  /**
   * Full scan paginado (T4). `fetchPage` trae y persiste una página; el
   * genérico maneja contadores, tolerancia a fallo por página y fin de datos.
   */
  private async paginate(
    state: RunState,
    fetchPage: (
      rsStart: number,
      pageSize: number,
    ) => Promise<MaximoFetchResult<unknown>>,
  ): Promise<MaximoSyncRunSummary> {
    const pageSize = this.syncConfig.pageSize;
    let rsStart = 0;
    let rsTotal: number | null = null;
    let consecutiveFailures = 0;
    let terminated = false;

    try {
      for (let guard = 0; guard < MAX_PAGES_GUARD && !terminated; guard++) {
        try {
          const page = await fetchPage(rsStart, pageSize);
          consecutiveFailures = 0;
          state.pagesOk += 1;
          const got = page.raw.length;
          state.recordsFetched += got;
          if (page.filterCheck && !page.filterCheck.applied) {
            state.filterWarnings.push({
              rsStart,
              ...page.filterCheck,
            });
          }
          const pageTotal = page.legacyPage?.rsTotal ?? null;
          if (pageTotal !== null) {
            rsTotal = pageTotal;
            state.pagesTotal = Math.max(1, Math.ceil(pageTotal / pageSize));
          }
          if (rsTotal !== null) {
            // Con total conocido, una página corta NO termina el escaneo (la
            // API legacy "acepta parámetros inválidos en silencio"): se avanza
            // lo realmente recibido y se sigue hasta cubrir rsTotal.
            rsStart += got > 0 ? got : pageSize;
            if (rsStart >= rsTotal) {
              terminated = true;
            } else if (got === 0) {
              this.pushError(
                state,
                `página vacía en rsStart=${rsStart - pageSize} con rsTotal=${rsTotal} restante — corrida truncada`,
              );
              terminated = true;
            }
          } else {
            if (got < pageSize) terminated = true; // última página
            rsStart += pageSize;
          }
        } catch (error: unknown) {
          state.pagesFailed += 1;
          consecutiveFailures += 1;
          this.pushError(state, `página rsStart=${rsStart}: ${message(error)}`);
          rsStart += pageSize;
          if (rsTotal !== null && rsStart >= rsTotal) terminated = true;
          if (
            rsTotal === null &&
            consecutiveFailures >= MAX_CONSECUTIVE_PAGE_FAILURES
          ) {
            // Sin total conocido y fallando en cadena: no hay forma fiable de
            // saber dónde termina el conjunto — se corta la corrida.
            terminated = true;
          }
        }
      }
      if (!terminated) {
        // El guard de páginas se agotó sin fin natural: dejarlo constar para
        // que la corrida quede 'partial' y no un 'success' truncado en silencio.
        this.pushError(
          state,
          `MAX_PAGES_GUARD (${MAX_PAGES_GUARD}) alcanzado — corrida truncada en rsStart=${rsStart}`,
        );
        state.pagesFailed += 1;
      }
      return await this.finishRun(state);
    } finally {
      this.running.delete(state.target);
    }
  }

  private async upsertOne(
    state: RunState,
    upsert: () => Promise<'inserted' | 'updated' | 'unchanged'>,
  ): Promise<void> {
    try {
      const outcome = await upsert();
      if (outcome === 'inserted') state.recordsInserted += 1;
      else if (outcome === 'updated') state.recordsUpdated += 1;
      else state.recordsUnchanged += 1;
    } catch (error: unknown) {
      state.recordsFailed += 1;
      this.pushError(state, `upsert: ${message(error)}`);
    }
  }

  private pushError(state: RunState, text: string): void {
    state.errors.push(
      text.length > ERROR_ITEM_MAX_CHARS
        ? `${text.slice(0, ERROR_ITEM_MAX_CHARS)}…`
        : text,
    );
  }

  private async finishRun(state: RunState): Promise<MaximoSyncRunSummary> {
    const status: MaximoSyncRunStatus =
      state.pagesOk === 0 && state.pagesFailed > 0
        ? 'failed'
        : state.pagesFailed > 0 ||
            state.recordsFailed > 0 ||
            state.errors.length > 0
          ? 'partial'
          : 'success';
    const errorSummary = state.errors.length
      ? state.errors.join(' | ').slice(0, ERROR_SUMMARY_MAX_CHARS)
      : null;

    await this.prisma.maximo_sync_runs.update({
      where: { id: state.runId },
      data: {
        finished_at: new Date(),
        status,
        pages_total: state.pagesTotal,
        pages_ok: state.pagesOk,
        records_fetched: state.recordsFetched,
        records_inserted: state.recordsInserted,
        records_updated: state.recordsUpdated,
        records_unchanged: state.recordsUnchanged,
        records_failed: state.recordsFailed,
        filter_warnings: state.filterWarnings.length
          ? (state.filterWarnings as object[])
          : undefined,
        error_summary: errorSummary,
      },
    });

    this.logger.log(
      `Corrida ${state.runId} (${state.target}, ${state.triggeredBy}) → ${status}: fetched=${state.recordsFetched} inserted=${state.recordsInserted} updated=${state.recordsUpdated} unchanged=${state.recordsUnchanged} failed=${state.recordsFailed} pagesOk=${state.pagesOk}/${state.pagesTotal ?? '-'} pagesFailed=${state.pagesFailed}`,
    );

    return {
      runId: state.runId,
      target: state.target,
      triggeredBy: state.triggeredBy,
      status,
      pagesTotal: state.pagesTotal,
      pagesOk: state.pagesOk,
      pagesFailed: state.pagesFailed,
      recordsFetched: state.recordsFetched,
      recordsInserted: state.recordsInserted,
      recordsUpdated: state.recordsUpdated,
      recordsUnchanged: state.recordsUnchanged,
      recordsFailed: state.recordsFailed,
      filterWarnings: state.filterWarnings,
      errorSummary,
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
