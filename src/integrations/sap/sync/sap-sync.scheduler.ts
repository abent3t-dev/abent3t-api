import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { LoggerLike } from '../../common';
import { SAP_LOGGER } from '../sap.config';
import { SapSyncService } from './sap-sync.service';
import { SAP_SYNC_CONFIG } from './sap-sync.config';
import type { SapSyncConfig } from './sap-sync.config';
import { SapSyncInProgressError } from './sap-sync.errors';

/**
 * Scheduler del sync de SAP (Fase INT-4). Mismo patrón que Maximo:
 * `SAP_SYNC_INTERVAL_MINUTES` es configurable, así que se registra un
 * interval vía `SchedulerRegistry` en lugar de un `@Cron` estático. Gate
 * absoluto por `SAP_SYNC_ENABLED`: con false NO se registra nada. Jitter
 * inicial (30-60 s, distinto al de Maximo para no arrancar ambos syncs en
 * el mismo segundo del deploy). Orden por corrida: OC, solicitudes, proveedores.
 * El cron siempre corre en modo default (incremental si hay datos).
 */
export const SAP_SYNC_TIMEOUT_NAME = 'sap-sync-initial';
export const SAP_SYNC_INTERVAL_NAME = 'sap-sync-interval';

const JITTER_BASE_MS = 30_000;
const JITTER_SPREAD_MS = 30_000;

@Injectable()
export class SapSyncScheduler implements OnApplicationBootstrap {
  private readonly logger: LoggerLike;

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
      void this.tick();
      const interval = setInterval(() => void this.tick(), intervalMs);
      this.registry.addInterval(SAP_SYNC_INTERVAL_NAME, interval);
    }, jitterMs);
    this.registry.addTimeout(SAP_SYNC_TIMEOUT_NAME, timeout);

    this.logger.log(
      `Sync de SAP programado cada ${this.config.intervalMinutes} min (primer disparo en ~${Math.round(jitterMs / 1000)} s)`,
    );
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
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`cron: sync de ${target} falló: ${msg}`);
    }
  }
}
