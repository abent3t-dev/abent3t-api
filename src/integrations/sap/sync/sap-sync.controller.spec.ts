import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { SapSyncController } from './sap-sync.controller';
import { SapSyncService } from './sap-sync.service';
import { SapSyncStatusService } from './sap-sync-status.service';
import { SapSyncInProgressError } from './sap-sync.errors';

/**
 * Fase INT-4. Controller con services mockeados. Cubre la decisión
 * 503-vs-409 (flag apagado vs corrida en curso) y el 202 con run_ids.
 */

function makeController(opts: { enabled?: boolean } = {}) {
  let runSeq = 0;
  const syncService = {
    isRunning: jest.fn((target: string) => target.length < 0),
    startTarget: jest.fn(() => Promise.resolve(`run-${++runSeq}`)),
  };
  const statusService = {
    getStatus: jest.fn(() => Promise.resolve({ enabled: true })),
    getRuns: jest.fn(() => Promise.resolve({ data: [], meta: {} })),
  };
  const controller = new SapSyncController(
    syncService as unknown as SapSyncService,
    statusService as unknown as SapSyncStatusService,
    { enabled: opts.enabled ?? true, intervalMinutes: 60, pageSize: 20 },
  );
  return { controller, syncService, statusService };
}

const USER = { id: 'user-1' };

describe('SapSyncController — POST /integrations/sap/sync', () => {
  it('flag apagado → 503 sin tocar el service', async () => {
    const h = makeController({ enabled: false });
    await expect(h.controller.triggerSync({}, USER)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(h.syncService.startTarget).not.toHaveBeenCalled();
  });

  it('default: dispara ambos targets y responde 202 con run_ids', async () => {
    const h = makeController();
    const result = await h.controller.triggerSync({}, USER);
    expect(result.accepted).toBe(true);
    expect(result.runs).toEqual([
      { target: 'purchase_orders', run_id: 'run-1' },
      { target: 'purchase_requests', run_id: 'run-2' },
    ]);
    expect(h.syncService.startTarget).toHaveBeenCalledWith(
      'purchase_orders',
      'manual',
      'user-1',
      undefined,
    );
  });

  it('propaga target y mode explícitos', async () => {
    const h = makeController();
    const result = await h.controller.triggerSync(
      { target: 'purchase_requests', mode: 'full' },
      USER,
    );
    expect(result.runs).toHaveLength(1);
    expect(h.syncService.startTarget).toHaveBeenCalledWith(
      'purchase_requests',
      'manual',
      'user-1',
      'full',
    );
  });

  it('corrida en curso (pre-chequeo) → 409 sin crear corridas', async () => {
    const h = makeController();
    h.syncService.isRunning.mockImplementation(
      (t: string) => t === 'purchase_orders',
    );
    await expect(h.controller.triggerSync({}, USER)).rejects.toThrow(
      ConflictException,
    );
    expect(h.syncService.startTarget).not.toHaveBeenCalled();
  });

  it('carrera con el cron: un target acepta y el otro conflictúa → 202 con el conflicto reportado', async () => {
    const h = makeController();
    h.syncService.startTarget
      .mockImplementationOnce(() => Promise.resolve('run-1'))
      .mockImplementationOnce(() =>
        Promise.reject(new SapSyncInProgressError('purchase_requests')),
      );
    const result = await h.controller.triggerSync({}, USER);
    expect(result.runs).toEqual([
      { target: 'purchase_orders', run_id: 'run-1' },
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].target).toBe('purchase_requests');
  });
});
