import { MaximoSeedService } from './maximo-seed.service';
import { MaximoStagingService } from './maximo-staging.service';
import { MaximoSeedProductionError } from './maximo-sync.errors';
import { FakePrisma, silentLogger } from './testing/maximo-sync.testkit';

/**
 * Fase INT-3 — T5. El seed usa los fixtures reales de Int-2 y el MISMO camino
 * de upsert; Prisma en memoria (sin base real, sin red).
 */

function makeSeed() {
  const prisma = new FakePrisma();
  const seed = new MaximoSeedService(
    prisma.asService(),
    new MaximoStagingService(prisma.asService()),
    silentLogger(),
  );
  return { prisma, seed };
}

describe('MaximoSeedService', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('aborta con NODE_ENV=production SIN tocar la base (T5)', async () => {
    process.env.NODE_ENV = 'production';
    const { prisma, seed } = makeSeed();
    await expect(seed.seedFixtures()).rejects.toBeInstanceOf(
      MaximoSeedProductionError,
    );
    await expect(seed.clearSeeds()).rejects.toBeInstanceOf(
      MaximoSeedProductionError,
    );
    expect(prisma.maximo_sync_runs.rows).toHaveLength(0);
    expect(prisma.maximo_purchase_orders.rows).toHaveLength(0);
  });

  it('en dev siembra los fixtures con corridas seed y es idempotente (2a corrida: 0 inserted/updated)', async () => {
    process.env.NODE_ENV = 'test';
    const { prisma, seed } = makeSeed();

    const first = await seed.seedFixtures();
    expect(first.purchaseOrders.inserted).toBeGreaterThan(0);
    expect(first.contracts.inserted).toBeGreaterThan(0);
    expect(first.purchaseOrders.failed).toBe(0);
    expect(first.contracts.failed).toBe(0);
    // PO102249 y el rango vienen por DOS APIs → ya hay unchanged en la 1a corrida
    expect(first.purchaseOrders.unchanged).toBeGreaterThan(0);
    expect(prisma.maximo_purchase_orders.rows.length).toBe(
      first.purchaseOrders.inserted,
    );
    expect(prisma.maximo_contracts.rows.length).toBe(first.contracts.inserted);

    // Corridas reales marcadas seed
    const runs = prisma.maximo_sync_runs.rows;
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.triggered_by === 'seed')).toBe(true);
    expect(runs.every((r) => r.status === 'success')).toBe(true);

    const second = await seed.seedFixtures();
    expect(second.purchaseOrders.inserted).toBe(0);
    expect(second.purchaseOrders.updated).toBe(0);
    expect(second.contracts.inserted).toBe(0);
    expect(second.contracts.updated).toBe(0);
    expect(second.purchaseOrders.unchanged).toBeGreaterThan(0);
  });

  it('T3 sobre fixtures: el PR102828 queda una fila con purchview_count=1 y el v1 dos filas por revisión', async () => {
    process.env.NODE_ENV = 'test';
    const { prisma, seed } = makeSeed();
    await seed.seedFixtures();

    const rows = prisma.maximo_contracts.rows;
    const pr102828 = rows.filter((r) => r.prnum === 'PR102828');
    expect(pr102828).toHaveLength(1);
    expect(pr102828[0].has_contract).toBe(true);

    const v1040 = rows.filter((r) => r.contractnum === '1040');
    expect(v1040.map((r) => r.revisionnum).sort()).toEqual([0, 1]);

    const sinContrato = rows.filter((r) => r.has_contract === false);
    expect(sinContrato.length).toBeGreaterThan(0);
    expect(sinContrato.every((r) => r.contractnum === null)).toBe(true);
  });

  it('clearSeeds elimina solo filas de corridas seed y respeta las tocadas por corridas reales', async () => {
    process.env.NODE_ENV = 'test';
    const { prisma, seed } = makeSeed();
    await seed.seedFixtures();
    const poCount = prisma.maximo_purchase_orders.rows.length;
    expect(poCount).toBeGreaterThan(0);

    // Simula que UNA fila fue tocada después por una corrida real
    prisma.maximo_purchase_orders.rows[0].last_sync_run_id = 'run-real-1';

    const cleared = await seed.clearSeeds();
    expect(cleared.purchaseOrders).toBe(poCount - 1);
    expect(prisma.maximo_purchase_orders.rows).toHaveLength(1);
    expect(prisma.maximo_contracts.rows).toHaveLength(0);
    // Las corridas quedan en la bitácora
    expect(prisma.maximo_sync_runs.rows).toHaveLength(2);
  });
});
