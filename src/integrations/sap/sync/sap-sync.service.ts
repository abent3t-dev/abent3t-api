import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type { LoggerLike } from '../../common';
import { SAP_LOGGER } from '../sap.config';
import { SapClient } from '../sap.client';
import type { SapFetchResult } from '../sap.client';
import { SAP_MAPPER_VERSION } from '../sap.mapper';
import { SapStagingService } from './sap-staging.service';
import { SAP_SYNC_CONFIG } from './sap-sync.config';
import type { SapSyncConfig } from './sap-sync.config';
import {
  SapSyncDisabledError,
  SapSyncInProgressError,
} from './sap-sync.errors';
import {
  SapSyncCounters,
  SapSyncMode,
  SapSyncRunStatus,
  SapSyncRunSummary,
  SapSyncTarget,
  SapSyncTrigger,
} from './sap-sync.types';

/**
 * Motor de sincronización SAP → staging (Fase INT-4).
 *
 * SOLO LECTURA hacia SAP: el único camino HTTP es `SapClient` (GETs sobre
 * Int-1) más el login aislado del `SapSessionManager` (T2). Escribe
 * únicamente en NUESTRA base (staging) vía `SapStagingService`.
 *
 * - Paginación `$orderby=DocEntry` + `$top/$skip`; `/$count` previo (con el
 *   mismo `$filter`) da `pages_total`.
 * - Modo `incremental` (default cuando el staging YA tiene datos): filtra
 *   `UpdateDate ge (max(update_date_source) − margen)`. El margen de 2 días
 *   cubre la granularidad de DÍA de UpdateDate y ediciones tardías del mismo
 *   día de la última corrida. `full` = barrido completo (primera corrida o
 *   a petición).
 * - Tolerancia a fallo por página + mutex in-memory por target + zombie
 *   cleanup al arrancar: mismo contrato que el sync de Maximo.
 * - `SAP_SYNC_ENABLED=false` → `SapSyncDisabledError` sin tocar la red.
 */

const MAX_PAGES_GUARD = 1_000;
const ERROR_ITEM_MAX_CHARS = 300;
const ERROR_SUMMARY_MAX_CHARS = 2_000;
const MAX_CONSECUTIVE_PAGE_FAILURES = 3;
/** Margen del corte incremental (granularidad día de UpdateDate). */
const INCREMENTAL_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

/** Corridas `running` más viejas que esto se consideran zombies al arrancar. */
const STALE_RUN_THRESHOLD_MS = 30 * 60_000;

interface RunState extends SapSyncCounters {
  runId: string;
  target: SapSyncTarget;
  triggeredBy: SapSyncTrigger;
  mode: SapSyncMode;
  sinceFilter: Date | null;
  errors: string[];
}

@Injectable()
export class SapSyncService implements OnModuleInit {
  private readonly logger: LoggerLike;
  private readonly running = new Set<SapSyncTarget>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: SapClient,
    private readonly staging: SapStagingService,
    @Inject(SAP_SYNC_CONFIG) private readonly syncConfig: SapSyncConfig,
    @Optional() @Inject(SAP_LOGGER) logger?: LoggerLike,
  ) {
    this.logger = logger ?? new Logger('Integration:sap-sync');
  }

  /** Zombie cleanup al arrancar (el mutex es in-memory). */
  async onModuleInit(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - STALE_RUN_THRESHOLD_MS);
      const stale = await this.prisma.sap_sync_runs.updateMany({
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
    } catch (err: unknown) {
      this.logger.error(`zombie cleanup falló al arrancar: ${message(err)}`);
    }
  }

  isRunning(target: SapSyncTarget): boolean {
    return this.running.has(target);
  }

  /** Corrida completa de PurchaseOrders (espera a que termine). */
  async syncPurchaseOrders(
    trigger: SapSyncTrigger,
    userId: string | null = null,
    mode?: SapSyncMode,
  ): Promise<SapSyncRunSummary> {
    const state = await this.beginRun('purchase_orders', trigger, userId, mode);
    return this.process(state);
  }

  /** Corrida completa de PurchaseRequests (espera a que termine). */
  async syncPurchaseRequests(
    trigger: SapSyncTrigger,
    userId: string | null = null,
    mode?: SapSyncMode,
  ): Promise<SapSyncRunSummary> {
    const state = await this.beginRun(
      'purchase_requests',
      trigger,
      userId,
      mode,
    );
    return this.process(state);
  }

  /** Disparo asíncrono: crea la corrida, devuelve el id, procesa en background. */
  async startTarget(
    target: SapSyncTarget,
    trigger: SapSyncTrigger,
    userId: string | null,
    mode?: SapSyncMode,
  ): Promise<string> {
    const state = await this.beginRun(target, trigger, userId, mode);
    void this.process(state).catch((err: unknown) =>
      this.failRunBestEffort(state, err),
    );
    return state.runId;
  }

  private async failRunBestEffort(
    state: RunState,
    err: unknown,
  ): Promise<void> {
    this.logger.error(
      `Corrida ${state.runId} (${state.target}) terminó con error inesperado: ${message(err)}`,
    );
    try {
      await this.prisma.sap_sync_runs.update({
        where: { id: state.runId },
        data: {
          status: 'failed',
          finished_at: new Date(),
          error_summary: message(err).slice(0, ERROR_SUMMARY_MAX_CHARS),
        },
      });
    } catch {
      // best-effort: el zombie cleanup del arranque la recogerá.
    }
  }

  // ---------------------------------------------------------------------------
  // Núcleo
  // ---------------------------------------------------------------------------

  /** Gate por flag + resolución de modo + mutex + fila `running`. */
  private async beginRun(
    target: SapSyncTarget,
    triggeredBy: SapSyncTrigger,
    userId: string | null,
    requestedMode?: SapSyncMode,
  ): Promise<RunState> {
    if (!this.syncConfig.enabled) {
      throw new SapSyncDisabledError();
    }
    if (this.running.has(target)) {
      throw new SapSyncInProgressError(target);
    }
    this.running.add(target);
    try {
      const { mode, sinceFilter } = await this.resolveMode(
        target,
        requestedMode,
      );
      const run = await this.prisma.sap_sync_runs.create({
        data: {
          target,
          triggered_by: triggeredBy,
          triggered_by_user_id: userId,
          mode,
          since_filter: sinceFilter,
          mapper_version: SAP_MAPPER_VERSION,
        },
        select: { id: true },
      });
      return {
        runId: run.id,
        target,
        triggeredBy,
        mode,
        sinceFilter,
        pagesTotal: null,
        pagesOk: 0,
        pagesFailed: 0,
        recordsFetched: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        recordsUnchanged: 0,
        recordsFailed: 0,
        errors: [],
      };
    } catch (err) {
      this.running.delete(target);
      throw err;
    }
  }

  /**
   * incremental pedido (o default) SOLO aplica cuando hay base confiable:
   * - staging con datos Y al menos un full EXITOSO previo del target (un
   *   full interrumpido dejaría el staging a medias con max(UpdateDate)
   *   reciente — sin esta guarda el hueco jamás se re-cubriría);
   * - si la última corrida terminó partial/failed, su corte se conserva
   *   (min con el calculado) para re-cubrir los documentos de sus páginas
   *   fallidas en la siguiente pasada.
   */
  private async resolveMode(
    target: SapSyncTarget,
    requested?: SapSyncMode,
  ): Promise<{ mode: SapSyncMode; sinceFilter: Date | null }> {
    if (requested === 'full') return { mode: 'full', sinceFilter: null };
    const fullOk = await this.prisma.sap_sync_runs.findFirst({
      where: { target, mode: 'full', status: 'success' },
      select: { id: true },
    });
    if (!fullOk) return { mode: 'full', sinceFilter: null };
    const agg =
      target === 'purchase_orders'
        ? await this.prisma.sap_purchase_orders.aggregate({
            _max: { update_date_source: true },
          })
        : await this.prisma.sap_purchase_requests.aggregate({
            _max: { update_date_source: true },
          });
    const maxUpdate = agg._max.update_date_source;
    if (!maxUpdate) return { mode: 'full', sinceFilter: null };
    let since = new Date(maxUpdate.getTime() - INCREMENTAL_MARGIN_MS);
    const lastRun = await this.prisma.sap_sync_runs.findFirst({
      where: { target, status: { not: 'running' } },
      orderBy: { started_at: 'desc' },
      select: { status: true, since_filter: true },
    });
    if (
      lastRun &&
      lastRun.status !== 'success' &&
      lastRun.since_filter &&
      lastRun.since_filter < since
    ) {
      since = lastRun.since_filter;
    }
    return { mode: 'incremental', sinceFilter: since };
  }

  private async process(state: RunState): Promise<SapSyncRunSummary> {
    const pageSize = this.syncConfig.pageSize;
    const since = state.sinceFilter ?? undefined;
    let skip = 0;
    let total: number | null = null;
    let consecutiveFailures = 0;
    let terminated = false;

    try {
      // /$count con el mismo filtro → pages_total (best-effort: si falla,
      // se loguea pero NO ensucia la corrida — el escaneo funciona sin él).
      try {
        total =
          state.target === 'purchase_orders'
            ? await this.client.countPurchaseOrders(since)
            : await this.client.countPurchaseRequests(since);
        state.pagesTotal = Math.max(1, Math.ceil(total / pageSize));
      } catch (err: unknown) {
        this.logger.warn(
          `$count de ${state.target} falló (no bloqueante): ${message(err)}`,
        );
      }

      for (let guard = 0; guard < MAX_PAGES_GUARD && !terminated; guard++) {
        try {
          const page = await this.fetchPage(state, {
            top: pageSize,
            skip,
            updatedSince: since,
          });
          consecutiveFailures = 0;
          state.pagesOk += 1;
          const got = page.raw.length;
          state.recordsFetched += got;
          // Terminación: página vacía = fin seguro. Una página CORTA solo es
          // fin cuando ya cubrimos el total (o no hay total): el Service
          // Layer puede acotar $top a su PageSize de b1s.conf y devolver
          // menos de lo pedido sin que sea la última página; y si la
          // colección creció durante la corrida, se sigue más allá del
          // total inicial hasta la página vacía.
          if (got === 0) {
            terminated = true;
          } else {
            skip += got;
            if (
              got < pageSize &&
              !(total !== null && state.recordsFetched < total)
            ) {
              terminated = true;
            }
          }
        } catch (err: unknown) {
          state.pagesFailed += 1;
          consecutiveFailures += 1;
          this.pushError(state, `página skip=${skip}: ${message(err)}`);
          skip += pageSize;
          if (total !== null && skip >= total) terminated = true;
          if (consecutiveFailures >= MAX_CONSECUTIVE_PAGE_FAILURES) {
            terminated = true;
          }
        }
      }
      if (!terminated) {
        this.pushError(
          state,
          `MAX_PAGES_GUARD (${MAX_PAGES_GUARD}) alcanzado — corrida truncada en skip=${skip}`,
        );
        state.pagesFailed += 1;
      }
      return await this.finishRun(state);
    } finally {
      this.running.delete(state.target);
    }
  }

  /** Trae y persiste una página del target. */
  private async fetchPage(
    state: RunState,
    params: { top: number; skip: number; updatedSince?: Date },
  ): Promise<SapFetchResult<unknown>> {
    if (state.target === 'purchase_orders') {
      const page = await this.client.fetchPurchaseOrders(params);
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
    }
    const page = await this.client.fetchPurchaseRequests(params);
    for (let i = 0; i < page.records.length; i++) {
      await this.upsertOne(state, () =>
        this.staging.upsertPurchaseRequest(
          page.records[i],
          page.raw[i],
          state.runId,
        ),
      );
    }
    return page;
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
    } catch (err: unknown) {
      state.recordsFailed += 1;
      this.pushError(state, `upsert: ${message(err)}`);
    }
  }

  private pushError(state: RunState, text: string): void {
    state.errors.push(
      text.length > ERROR_ITEM_MAX_CHARS
        ? `${text.slice(0, ERROR_ITEM_MAX_CHARS)}…`
        : text,
    );
  }

  private async finishRun(state: RunState): Promise<SapSyncRunSummary> {
    const status: SapSyncRunStatus =
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

    await this.prisma.sap_sync_runs.update({
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
        error_summary: errorSummary,
      },
    });

    this.logger.log(
      `Corrida ${state.runId} (${state.target}, ${state.triggeredBy}, ${state.mode}) → ${status}: ` +
        `fetched=${state.recordsFetched} inserted=${state.recordsInserted} updated=${state.recordsUpdated} ` +
        `unchanged=${state.recordsUnchanged} failed=${state.recordsFailed} pagesOk=${state.pagesOk}/${state.pagesTotal ?? '-'} pagesFailed=${state.pagesFailed}`,
    );

    return {
      runId: state.runId,
      target: state.target,
      triggeredBy: state.triggeredBy,
      mode: state.mode,
      sinceFilter: state.sinceFilter,
      status,
      pagesTotal: state.pagesTotal,
      pagesOk: state.pagesOk,
      pagesFailed: state.pagesFailed,
      recordsFetched: state.recordsFetched,
      recordsInserted: state.recordsInserted,
      recordsUpdated: state.recordsUpdated,
      recordsUnchanged: state.recordsUnchanged,
      recordsFailed: state.recordsFailed,
      errorSummary,
    };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
