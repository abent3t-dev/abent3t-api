import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { LoggerLike } from '../../common';
import { MAXIMO_LOGGER } from '../maximo.config';
import { MaximoSyncService } from './maximo-sync.service';
import { MAXIMO_SYNC_CONFIG } from './maximo-sync.config';
import type { MaximoSyncConfig } from './maximo-sync.config';
import { MaximoSyncInProgressError } from './maximo-sync.errors';
import { isSyncSkipped } from './maximo-sync.types';

/**
 * Scheduler del sync de Maximo (Fase INT-3).
 *
 * `MAXIMO_SYNC_INTERVAL_MINUTES` es configurable, así que en lugar de un
 * `@Cron` estático se registra un interval vía `SchedulerRegistry` (mismo
 * runtime de @nestjs/schedule que usan reminders/platforms). Gate absoluto
 * por `MAXIMO_SYNC_ENABLED`: con false NO se registra nada y `tick()` retorna
 * sin llamar al service. Jitter inicial (15-45 s) para no sincronizar en el
 * segundo cero del deploy. Orden por corrida: POs, luego contratos.
 */
export const MAXIMO_SYNC_TIMEOUT_NAME = 'maximo-sync-initial';
export const MAXIMO_SYNC_INTERVAL_NAME = 'maximo-sync-interval';

const JITTER_BASE_MS = 15_000;
const JITTER_SPREAD_MS = 30_000;

@Injectable()
export class MaximoSyncScheduler implements OnApplicationBootstrap {
  private readonly logger: LoggerLike;

  constructor(
    private readonly syncService: MaximoSyncService,
    private readonly registry: SchedulerRegistry,
    @Inject(MAXIMO_SYNC_CONFIG) private readonly config: MaximoSyncConfig,
    @Optional() @Inject(MAXIMO_LOGGER) logger?: LoggerLike,
  ) {
    this.logger = logger ?? new Logger('Integration:maximo-sync');
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log(
        'Sync de Maximo apagado (MAXIMO_SYNC_ENABLED=false): cron NO registrado',
      );
      return;
    }
    const intervalMs = this.config.intervalMinutes * 60_000;
    const jitterMs =
      JITTER_BASE_MS + Math.floor(Math.random() * JITTER_SPREAD_MS);

    const timeout = setTimeout(() => {
      void this.tick();
      const interval = setInterval(() => void this.tick(), intervalMs);
      this.registry.addInterval(MAXIMO_SYNC_INTERVAL_NAME, interval);
    }, jitterMs);
    this.registry.addTimeout(MAXIMO_SYNC_TIMEOUT_NAME, timeout);

    this.logger.log(
      `Sync de Maximo programado cada ${this.config.intervalMinutes} min (primer disparo en ~${Math.round(jitterMs / 1000)} s)`,
    );
  }

  /** Una pasada del cron: POs y luego contratos. Nunca lanza. */
  async tick(): Promise<void> {
    if (!this.config.enabled) return;
    await this.run('purchase_orders', () =>
      this.syncService.syncPurchaseOrders('cron'),
    );
    await this.run('contracts', async () => {
      const result = await this.syncService.syncContracts('cron');
      if (isSyncSkipped(result)) return; // ya logueado por el service
    });
  }

  private async run(
    target: string,
    work: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await work();
    } catch (error: unknown) {
      if (error instanceof MaximoSyncInProgressError) {
        this.logger.warn(
          `cron: corrida de ${target} aún en curso — tick omitido`,
        );
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`cron: sync de ${target} falló: ${msg}`);
    }
  }
}
