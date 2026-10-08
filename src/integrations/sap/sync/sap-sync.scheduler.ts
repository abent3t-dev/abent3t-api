import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import type { LoggerLike } from '../../common';
import { SAP_LOGGER } from '../sap.config';
import { SapSyncService } from './sap-sync.service';
import {
  parseDailyTime,
  SAP_SYNC_CONFIG,
  SAP_SYNC_FULL_DAILY_TIME_ZONE,
} from './sap-sync.config';
import type { SapSyncConfig } from './sap-sync.config';
import { SapSyncInProgressError } from './sap-sync.errors';
import { SAP_FULL_DAILY_TARGETS } from './sap-sync.types';
import type { SapSyncRunSummary, SapSyncTarget } from './sap-sync.types';

/**
 * Scheduler del sync de SAP (Fase INT-4). Mismo patrón que Maximo:
 * `SAP_SYNC_INTERVAL_MINUTES` es configurable, así que se registra un
 * interval vía `SchedulerRegistry` en lugar de un `@Cron` estático. Gate
 * absoluto por `SAP_SYNC_ENABLED`: con false NO se registra nada. Jitter
 * inicial (30-60 s, distinto al de Maximo para no arrancar ambos syncs en
 * el mismo segundo del deploy). Orden por corrida: OC, solicitudes, proveedores.
 * El cron siempre corre en modo default (incremental si hay datos).
 *
 * L1 (2026-10-08): además, un full diario de OC, solicitudes y proveedores
 * (`SAP_FULL_DAILY_TARGETS`) a `SAP_SYNC_FULL_DAILY_AT` (hora de México;
 * `off` lo apaga). SAP no mueve el `UpdateDate` del documento base cuando
 * otro lo cierra (la OC que cierra la solicitud, la entrada de mercancía que
 * cierra la OC) y el incremental nunca relee esos cierres. Es un `CronJob`
 * con timeZone, el mismo runtime de los `@Cron` del proyecto, registrado en
 * el `SchedulerRegistry` para que Nest lo detenga al apagar.
 *   - Respeta el mutex por target: con la corrida del target ocupada (el
 *     incremental o un disparo manual) espera y reintenta; nunca corren dos
 *     del mismo target a la vez.
 *   - Si el full falla o se interrumpe (el SL o el login caídos), reintenta
 *     cada 15 min durante ~2 h.
 *   - Al arrancar, después del primer tick, corre una vez el full de los
 *     targets sin full exitoso en 24 h: cubre un deploy a la hora del full y
 *     hace el primer full tras el deploy sin paso manual.
 *   - Una sola pasada a la vez (el cron y la recuperación no se enciman).
 */
export const SAP_SYNC_TIMEOUT_NAME = 'sap-sync-initial';
export const SAP_SYNC_INTERVAL_NAME = 'sap-sync-interval';
export const SAP_SYNC_FULL_DAILY_NAME = 'sap-sync-full-daily';

/** L1: con el target ocupado, reintento cada minuto durante ~30 min. */
export const FULL_DAILY_BUSY_RETRY_MS = 60_000;
export const FULL_DAILY_BUSY_MAX_ATTEMPTS = 30;
/**
 * L1: full fallido o interrumpido, reintento cada 15 min durante ~2 h. Con
 * los 30 min de espera por ocupado, cada target cierra en unas 3 h como
 * máximo: la pasada nunca alcanza a la del día siguiente.
 */
export const FULL_DAILY_FAILURE_RETRY_MS = 15 * 60_000;
export const FULL_DAILY_FAILURE_MAX_RETRIES = 8;
/** L1: al arrancar, se recupera el full de un target sin éxito en 24 h. */
export const FULL_DAILY_RECOVERY_AGE_MS = 24 * 60 * 60_000;

const JITTER_BASE_MS = 30_000;
const JITTER_SPREAD_MS = 30_000;

@Injectable()
export class SapSyncScheduler implements OnApplicationBootstrap {
  private readonly logger: LoggerLike;
  /** L1: hay una pasada del full diario (cron o recuperación) en curso. */
  private fullPassRunning = false;

  constructor(
    private readonly syncService: SapSyncService,
    private readonly registry: SchedulerRegistry,
    @Inject(SAP_SYNC_CONFIG) private readonly config: SapSyncConfig,
    @Optional() @Inject(SAP_LOGGER) logger?: LoggerLike,
  ) {
    this.logger = logger ?? new Logger('Integration:sap-sync');
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log(
        'Sync de SAP apagado (SAP_SYNC_ENABLED=false): cron NO registrado',
      );
      return;
    }
    const intervalMs = this.config.intervalMinutes * 60_000;
    const jitterMs =
      JITTER_BASE_MS + Math.floor(Math.random() * JITTER_SPREAD_MS);

    const timeout = setTimeout(() => {
      // L1: después del primer tick, la recuperación del full diario
      void this.tick().then(() => this.recoverFullDaily());
      const interval = setInterval(() => void this.tick(), intervalMs);
      this.registry.addInterval(SAP_SYNC_INTERVAL_NAME, interval);
    }, jitterMs);
    this.registry.addTimeout(SAP_SYNC_TIMEOUT_NAME, timeout);

    this.logger.log(
      `Sync de SAP programado cada ${this.config.intervalMinutes} min (primer disparo en ~${Math.round(jitterMs / 1000)} s)`,
    );
    this.scheduleFullDaily();
  }

  /** Una pasada del cron: OC y luego solicitudes de pedido. Nunca lanza. */
  async tick(): Promise<void> {
    if (!this.config.enabled) return;
    await this.run('purchase_orders', () =>
      this.syncService.syncPurchaseOrders('cron'),
    );
    await this.run('purchase_requests', () =>
      this.syncService.syncPurchaseRequests('cron'),
    );
    await this.run('business_partners', () =>
      this.syncService.syncBusinessPartners('cron'),
    );
    await this.run('approval_requests', () =>
      this.syncService.syncApprovalRequests('cron'),
    );
  }

  /**
   * L1: una pasada del full diario: `SAP_FULL_DAILY_TARGETS` en orden, en
   * modo full y con `triggered_by='cron'`. Nunca lanza.
   */
  async fullDailyTick(): Promise<void> {
    if (!this.config.enabled) return;
    await this.runFullPass(SAP_FULL_DAILY_TARGETS);
  }

  /**
   * L1: recuperación al arrancar: corre una vez el full de los targets del
   * full diario cuyo último full EXITOSO tiene más de 24 h (o no existe).
   * Nada con `SAP_SYNC_ENABLED=false` ni con `SAP_SYNC_FULL_DAILY_AT=off`.
   * Nunca lanza.
   */
  async recoverFullDaily(): Promise<void> {
    if (!this.config.enabled || this.config.fullDailyAt === null) return;
    const stale: SapSyncTarget[] = [];
    try {
      for (const target of SAP_FULL_DAILY_TARGETS) {
        const last = await this.syncService.lastFullSuccessAt(target);
        if (!last || Date.now() - last.getTime() > FULL_DAILY_RECOVERY_AGE_MS) {
          stale.push(target);
        }
      }
    } catch (err: unknown) {
      this.logger.error(
        `recuperación del full diario: no se pudo leer el último full: ${message(err)}`,
      );
      return;
    }
    if (stale.length === 0) {
      this.logger.log(
        'recuperación del full diario: al día (último full exitoso con menos de 24 h)',
      );
      return;
    }
    this.logger.log(
      `recuperación del full diario al arrancar: ${stale.join(', ')} sin full exitoso en 24 h`,
    );
    await this.runFullPass(stale);
  }

  /** L1: registra el full diario; con `SAP_SYNC_FULL_DAILY_AT=off`, nada. */
  private scheduleFullDaily(): void {
    const at = this.config.fullDailyAt;
    const time = at === null ? null : parseDailyTime(at);
    if (!time) {
      this.logger.log(
        'Full diario de SAP apagado (SAP_SYNC_FULL_DAILY_AT=off): cron NO registrado',
      );
      return;
    }
    const job = CronJob.from({
      cronTime: `${time.minute} ${time.hour} * * *`,
      onTick: () => this.fullDailyTick(),
      timeZone: SAP_SYNC_FULL_DAILY_TIME_ZONE,
      name: SAP_SYNC_FULL_DAILY_NAME,
    });
    this.registry.addCronJob(SAP_SYNC_FULL_DAILY_NAME, job);
    job.start();
    this.logger.log(
      `Full diario de SAP (${SAP_FULL_DAILY_TARGETS.join(', ')}) programado a las ${at} (${SAP_SYNC_FULL_DAILY_TIME_ZONE})`,
    );
  }

  private async run(
    target: string,
    work: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await work();
    } catch (err: unknown) {
      if (err instanceof SapSyncInProgressError) {
        this.logger.warn(
          `cron: corrida de ${target} aún en curso — tick omitido`,
        );
        return;
      }
      this.logger.error(`cron: sync de ${target} falló: ${message(err)}`);
    }
  }

  /** L1: una pasada a la vez; la que llega con otra en curso se omite. */
  private async runFullPass(targets: readonly SapSyncTarget[]): Promise<void> {
    if (this.fullPassRunning) {
      this.logger.warn(
        'full diario: ya hay una pasada en curso — se omite esta',
      );
      return;
    }
    this.fullPassRunning = true;
    try {
      for (const target of targets) await this.runFull(target);
    } finally {
      this.fullPassRunning = false;
    }
  }

  /**
   * L1: full de un target con dos esperas distintas:
   *   - ocupado (409 del service): cada `FULL_DAILY_BUSY_RETRY_MS` hasta
   *     `FULL_DAILY_BUSY_MAX_ATTEMPTS` intentos (el incremental de un target
   *     tarda segundos y un full ~150 s);
   *   - falla: corrida `failed`, con páginas fallidas (el SL se cayó a media
   *     corrida) o un error que no es de ocupado: cada
   *     `FULL_DAILY_FAILURE_RETRY_MS` hasta `FULL_DAILY_FAILURE_MAX_RETRIES`
   *     veces. Un `partial` solo por documentos que no se pudieron guardar no
   *     se reintenta: es del documento, no del SL, y fallaría igual.
   * Agotado cualquiera de los dos, se omite hasta el día siguiente.
   */
  private async runFull(target: SapSyncTarget): Promise<void> {
    let busy = 0;
    let failures = 0;
    for (;;) {
      let failure: string;
      try {
        const summary = await this.fullSync(target);
        if (summary.status !== 'failed' && summary.pagesFailed === 0) {
          if (summary.status === 'partial') {
            this.logger.warn(
              `full diario: ${target} terminó partial por documentos que no se guardaron (corrida ${summary.runId}); no se reintenta`,
            );
          }
          return;
        }
        failure = `corrida ${summary.runId} terminó ${summary.status} (${summary.pagesFailed} página(s) fallida(s))`;
      } catch (err: unknown) {
        if (err instanceof SapSyncInProgressError) {
          busy += 1;
          if (busy >= FULL_DAILY_BUSY_MAX_ATTEMPTS) {
            this.logger.warn(
              `full diario: ${target} siguió ocupado tras ${busy} intentos — se omite hasta mañana`,
            );
            return;
          }
          this.logger.warn(
            `full diario: corrida de ${target} en curso — reintento en ${FULL_DAILY_BUSY_RETRY_MS / 1000} s (${busy}/${FULL_DAILY_BUSY_MAX_ATTEMPTS})`,
          );
          await delay(FULL_DAILY_BUSY_RETRY_MS);
          continue;
        }
        failure = message(err);
      }
      failures += 1;
      if (failures > FULL_DAILY_FAILURE_MAX_RETRIES) {
        this.logger.error(
          `full diario: ${target} falló ${failures} veces (${failure}) — se omite hasta mañana`,
        );
        return;
      }
      this.logger.warn(
        `full diario: ${target} falló (${failure}) — reintento en ${FULL_DAILY_FAILURE_RETRY_MS / 60_000} min (${failures}/${FULL_DAILY_FAILURE_MAX_RETRIES})`,
      );
      await delay(FULL_DAILY_FAILURE_RETRY_MS);
    }
  }

  /** L1: corrida full (espera a que termine) del target. */
  private fullSync(target: SapSyncTarget): Promise<SapSyncRunSummary> {
    switch (target) {
      case 'purchase_orders':
        return this.syncService.syncPurchaseOrders('cron', null, 'full');
      case 'purchase_requests':
        return this.syncService.syncPurchaseRequests('cron', null, 'full');
      case 'business_partners':
        return this.syncService.syncBusinessPartners('cron', null, 'full');
      case 'approval_requests':
        return this.syncService.syncApprovalRequests('cron');
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Espera sin retener el proceso al apagar (`unref`). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
