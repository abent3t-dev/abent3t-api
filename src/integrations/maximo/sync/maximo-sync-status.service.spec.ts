import { MaximoSyncStatusService } from './maximo-sync-status.service';
import { MaximoSyncService } from './maximo-sync.service';
import { MaximoSyncConfig } from './maximo-sync.config';
import { MaximoConfig } from '../maximo.config';
import { FakePrisma } from './testing/maximo-sync.testkit';

/** Fase INT-3. Forma documentada de GET /status y GET /runs, sin red ni BD. */

function makeStatus(runningTargets: string[] = []) {
  const prisma = new FakePrisma();
  const syncService = {
    isRunning: jest.fn((t: string) => runningTargets.includes(t)),
  };
  const syncConfig: MaximoSyncConfig = {
    enabled: false,
    intervalMinutes: 60,
    pageSize: 100,
  };
  const maximoConfig = { contractsEnabled: false } as MaximoConfig;
  const service = new MaximoSyncStatusService(
    prisma.asService(),
    syncService as unknown as MaximoSyncService,
    syncConfig,
    maximoConfig,
  );
  return { prisma, service };
}

async function seedRuns(prisma: FakePrisma, target: string, n: number) {
  for (let i = 0; i < n; i++) {
    await prisma.maximo_sync_runs.create({
      data: {
        target,
        triggered_by: 'manual',
        mapper_version: 'v',
        started_at: new Date(2026, 7, 1 + i),
      },
    });
  }
}

describe('MaximoSyncStatusService', () => {
  it('getStatus devuelve la forma documentada: flags, running, lastRuns y counts', async () => {
    const { prisma, service } = makeStatus(['purchase_orders']);
    await seedRuns(prisma, 'purchase_orders', 2);
    await prisma.maximo_purchase_orders.create({ data: { ponum: 'PO1' } });
    await prisma.maximo_purchase_orders.create({ data: { ponum: 'PO2' } });
    await prisma.maximo_contracts.create({ data: { prnum: 'PR1' } });

    const status = await service.getStatus();
    expect(Object.keys(status).sort()).toEqual([
      'contractsEnabled',
      'counts',
      'enabled',
      'intervalMinutes',
      'lastRuns',
      'pageSize',
      'running',
    ]);
    expect(status.enabled).toBe(false);
    expect(status.contractsEnabled).toBe(false);
    expect(status.intervalMinutes).toBe(60);
    expect(status.pageSize).toBe(100);
    expect(status.running).toEqual(['purchase_orders']);
    expect(status.counts).toEqual({ purchase_orders: 2, contracts: 1 });
    expect(status.lastRuns.purchase_orders).not.toBeNull();
    expect(status.lastRuns.contracts).toBeNull();
  });

  it('getRuns pagina con la meta estándar del repo (total/totalPages/hasNext/hasPrev)', async () => {
    const { prisma, service } = makeStatus();
    await seedRuns(prisma, 'purchase_orders', 5);
    await seedRuns(prisma, 'contracts', 2);

    const page2 = await service.getRuns('purchase_orders', 2, 2);
    expect(page2.data).toHaveLength(2);
    expect(page2.meta).toEqual({
      total: 5,
      page: 2,
      limit: 2,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });

    const all = await service.getRuns(undefined, 1, 20);
    expect(all.data).toHaveLength(7);
    expect(all.meta.totalPages).toBe(1);
    expect(all.meta.hasNext).toBe(false);
    expect(all.meta.hasPrev).toBe(false);
  });
});
