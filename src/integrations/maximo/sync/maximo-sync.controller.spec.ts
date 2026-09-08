import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { MaximoSyncController } from './maximo-sync.controller';
import { MaximoSyncService } from './maximo-sync.service';
import { MaximoSyncStatusService } from './maximo-sync-status.service';
import { MaximoSyncConfig } from './maximo-sync.config';
import { MaximoSyncInProgressError } from './maximo-sync.errors';

/** Fase INT-3. Controller probado en unitario (services mockeados, sin red). */

const USER = { id: 'user-1' };

function makeController(
  enabled = true,
  overrides: Partial<Record<string, jest.Mock>> = {},
) {
  const syncService = {
    isRunning: jest.fn().mockReturnValue(false),
    startPurchaseOrders: jest.fn().mockResolvedValue('run-po-1'),
    startContracts: jest.fn().mockResolvedValue('run-ct-1'),
    ...overrides,
  };
  const statusService = {
    getStatus: jest.fn().mockResolvedValue({ enabled }),
    getRuns: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
  };
  const config: MaximoSyncConfig = {
    enabled,
    intervalMinutes: 60,
    pageSize: 100,
  };
  const controller = new MaximoSyncController(
    syncService as unknown as MaximoSyncService,
    statusService as unknown as MaximoSyncStatusService,
    config,
  );
  return { controller, syncService, statusService };
}

describe('MaximoSyncController', () => {
  it('POST /sync con MAXIMO_SYNC_ENABLED=false → 503 tipado SIN tocar el service', async () => {
    const { controller, syncService } = makeController(false);
    await expect(controller.triggerSync({}, USER)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(syncService.startPurchaseOrders).not.toHaveBeenCalled();
    expect(syncService.startContracts).not.toHaveBeenCalled();
  });

  it('POST /sync default all → 202 con run_id de ambos targets, disparo con usuario', async () => {
    const { controller, syncService } = makeController();
    const res = await controller.triggerSync({}, USER);
    expect(res).toEqual({
      accepted: true,
      runs: [
        { target: 'purchase_orders', run_id: 'run-po-1' },
        { target: 'contracts', run_id: 'run-ct-1' },
      ],
      skipped: [],
      conflicts: [],
    });
    expect(syncService.startPurchaseOrders).toHaveBeenCalledWith(
      'manual',
      'user-1',
    );
    expect(syncService.startContracts).toHaveBeenCalledWith('manual', 'user-1');
  });

  it('POST /sync target=contracts con contratos deshabilitados → 202 con skipped', async () => {
    const { controller } = makeController(true, {
      startContracts: jest.fn().mockResolvedValue({
        skipped: true,
        target: 'contracts',
        reason: 'MAXIMO_CONTRACTS_ENABLED=false',
      }),
    });
    const res = await controller.triggerSync({ target: 'contracts' }, USER);
    expect(res.runs).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toContain('MAXIMO_CONTRACTS_ENABLED');
  });

  it('POST /sync con corrida en curso → 409 (pre-chequeo y carrera del service)', async () => {
    const preCheck = makeController(true, {
      isRunning: jest.fn().mockImplementation((t) => t === 'purchase_orders'),
    });
    await expect(
      preCheck.controller.triggerSync({ target: 'purchase_orders' }, USER),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(preCheck.syncService.startPurchaseOrders).not.toHaveBeenCalled();

    const race = makeController(true, {
      startPurchaseOrders: jest
        .fn()
        .mockRejectedValue(new MaximoSyncInProgressError('purchase_orders')),
    });
    await expect(
      race.controller.triggerSync({ target: 'purchase_orders' }, USER),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('target=all con carrera solo en contratos → 202 con el run aceptado y el conflicto reportado', async () => {
    const { controller } = makeController(true, {
      startContracts: jest
        .fn()
        .mockRejectedValue(new MaximoSyncInProgressError('contracts')),
    });
    const res = await controller.triggerSync({}, USER);
    expect(res.runs).toEqual([
      { target: 'purchase_orders', run_id: 'run-po-1' },
    ]);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].target).toBe('contracts');
  });

  it('GET /status y GET /runs delegan en el status service con defaults de paginación', async () => {
    const { controller, statusService } = makeController();
    await controller.getStatus();
    expect(statusService.getStatus).toHaveBeenCalledTimes(1);

    await controller.getRuns({});
    expect(statusService.getRuns).toHaveBeenCalledWith(undefined, 1, 20);
    await controller.getRuns({ target: 'contracts', page: 3, limit: 5 });
    expect(statusService.getRuns).toHaveBeenCalledWith('contracts', 3, 5);
  });
});
