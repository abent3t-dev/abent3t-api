import { SchedulerRegistry } from '@nestjs/schedule';
import { MaximoSyncScheduler } from './maximo-sync.scheduler';
import { MaximoSyncService } from './maximo-sync.service';
import { MaximoSyncConfig } from './maximo-sync.config';
import { MaximoSyncInProgressError } from './maximo-sync.errors';
import { silentLogger } from './testing/maximo-sync.testkit';

/** Fase INT-3. Scheduler gobernado por MAXIMO_SYNC_ENABLED; sin red. */

function makeScheduler(enabled: boolean) {
  const lines: string[] = [];
  const syncService = {
    syncPurchaseOrders: jest.fn().mockResolvedValue({ status: 'success' }),
    syncContracts: jest.fn().mockResolvedValue({
      skipped: true,
      target: 'contracts',
      reason: 'x',
    }),
  };
  const registry = {
    addTimeout: jest.fn(),
    addInterval: jest.fn(),
  };
  const config: MaximoSyncConfig = {
    enabled,
    intervalMinutes: 60,
    pageSize: 100,
  };
  const scheduler = new MaximoSyncScheduler(
    syncService as unknown as MaximoSyncService,
    registry as unknown as SchedulerRegistry,
    config,
    silentLogger(lines),
  );
  return { scheduler, syncService, registry, lines };
}

describe('MaximoSyncScheduler', () => {
  it('con MAXIMO_SYNC_ENABLED=false NO registra cron y tick() no llama al service', async () => {
    const { scheduler, syncService, registry, lines } = makeScheduler(false);
    scheduler.onApplicationBootstrap();
    expect(registry.addTimeout).not.toHaveBeenCalled();
    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('cron NO registrado');

    await scheduler.tick();
    expect(syncService.syncPurchaseOrders).toHaveBeenCalledTimes(0);
    expect(syncService.syncContracts).toHaveBeenCalledTimes(0);
  });

  it('habilitado: registra timeout con jitter y el tick corre POs y luego contratos', async () => {
    jest.useFakeTimers();
    try {
      const { scheduler, syncService, registry } = makeScheduler(true);
      scheduler.onApplicationBootstrap();
      expect(registry.addTimeout).toHaveBeenCalledTimes(1);

      const order: string[] = [];
      syncService.syncPurchaseOrders.mockImplementation(() => {
        order.push('po');
        return Promise.resolve({ status: 'success' });
      });
      syncService.syncContracts.mockImplementation(() => {
        order.push('contracts');
        return Promise.resolve({
          skipped: true,
          target: 'contracts',
          reason: 'x',
        });
      });

      await scheduler.tick();
      expect(order).toEqual(['po', 'contracts']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('una corrida aún en curso (mutex) se tolera con warning; otros errores no tumban el tick', async () => {
    const { scheduler, syncService, lines } = makeScheduler(true);
    syncService.syncPurchaseOrders.mockRejectedValueOnce(
      new MaximoSyncInProgressError('purchase_orders'),
    );
    syncService.syncContracts.mockRejectedValueOnce(new Error('BD caída'));

    await expect(scheduler.tick()).resolves.toBeUndefined();
    const joined = lines.join('\n');
    expect(joined).toContain('aún en curso');
    expect(joined).toContain('BD caída');
  });
});
