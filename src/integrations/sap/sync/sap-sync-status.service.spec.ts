import { SapSyncStatusService } from './sap-sync-status.service';
import { SapSyncService } from './sap-sync.service';
import type { SapSyncConfig } from './sap-sync.config';
import { FakeSapPrisma } from './testing/sap-sync.testkit';

/**
 * L1 (2026-10-08). Forma de GET /integrations/sap/status, sin red ni BD: la
 * configuración del full diario y el último full EXITOSO por target, para
 * que Integraciones muestre si el full diario dejó de correr.
 */

function makeStatus(fullDailyAt: string | null = '03:00') {
  const prisma = new FakeSapPrisma();
  const syncService = {
    isRunning: jest.fn((t: string) => t === 'purchase_requests'),
  };
  const config: SapSyncConfig = {
    enabled: true,
    intervalMinutes: 60,
    pageSize: 20,
    fullDailyAt,
  };
  const service = new SapSyncStatusService(
    prisma.asService(),
    syncService as unknown as SapSyncService,
    config,
  );
  return { prisma, service };
}

async function seedRun(
  prisma: FakeSapPrisma,
  data: {
    target: string;
    mode: 'full' | 'incremental';
    status: string;
    started_at: string;
    triggered_by?: string;
  },
) {
  await prisma.sap_sync_runs.create({
    data: {
      triggered_by: 'cron',
      mapper_version: '1.3.0',
      ...data,
      started_at: new Date(data.started_at),
      finished_at: new Date(data.started_at),
    },
  });
}

describe('SapSyncStatusService (L1)', () => {
  it('getStatus trae fullDaily y el último full EXITOSO por target (no el último full ni la última corrida)', async () => {
    const { prisma, service } = makeStatus();
    const po = 'purchase_orders';
    await seedRun(prisma, {
      target: po,
      mode: 'full',
      status: 'success',
      started_at: '2026-10-06T09:00:00Z',
    });
    await seedRun(prisma, {
      target: po,
      mode: 'full',
      status: 'success',
      started_at: '2026-10-07T09:00:00Z',
      triggered_by: 'manual',
    });
    // full fallido posterior: no cuenta como "último full exitoso"
    await seedRun(prisma, {
      target: po,
      mode: 'full',
      status: 'partial',
      started_at: '2026-10-08T09:00:00Z',
    });
    await seedRun(prisma, {
      target: po,
      mode: 'incremental',
      status: 'success',
      started_at: '2026-10-08T10:00:00Z',
    });
    await seedRun(prisma, {
      target: 'purchase_requests',
      mode: 'incremental',
      status: 'success',
      started_at: '2026-10-08T10:00:10Z',
    });

    const status = await service.getStatus();
    expect(Object.keys(status).sort()).toEqual([
      'counts',
      'enabled',
      'fullDaily',
      'intervalMinutes',
      'lastFullSuccess',
      'lastRuns',
      'pageSize',
      'running',
    ]);
    expect(status.fullDaily).toEqual({
      at: '03:00',
      timeZone: 'America/Mexico_City',
      targets: ['purchase_orders', 'purchase_requests', 'business_partners'],
    });
    expect(status.running).toEqual(['purchase_requests']);
    expect(status.lastFullSuccess.purchase_orders).toEqual({
      id: expect.any(String) as unknown as string,
      triggered_by: 'manual',
      started_at: new Date('2026-10-07T09:00:00Z'),
      finished_at: new Date('2026-10-07T09:00:00Z'),
    });
    expect(status.lastFullSuccess.purchase_requests).toBeNull();
    expect(status.lastFullSuccess.business_partners).toBeNull();
    // la última corrida sigue siendo la más reciente, con records_remapped
    expect(status.lastRuns.purchase_orders).toMatchObject({
      mode: 'incremental',
      records_remapped: 0,
    });
  });

  it('con SAP_SYNC_FULL_DAILY_AT=off, fullDaily.at es null (apagado)', async () => {
    const { service } = makeStatus(null);
    const status = await service.getStatus();
    expect(status.fullDaily.at).toBeNull();
  });
});
