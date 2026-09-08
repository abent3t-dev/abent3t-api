import { MaximoRemapService } from './maximo-remap.service';
import { MaximoSeedService } from './maximo-seed.service';
import { MaximoStagingService } from './maximo-staging.service';
import { MAXIMO_MAPPER_VERSION } from '../maximo.mapper';
import { FakePrisma, silentLogger } from './testing/maximo-sync.testkit';

/**
 * Fase INT-3. `remapAll` re-ejecuta el mapper sobre el `raw` persistido:
 * cero llamadas al cliente (el service ni siquiera lo inyecta).
 */

async function seededPrisma(): Promise<FakePrisma> {
  process.env.NODE_ENV = 'test';
  const prisma = new FakePrisma();
  const seed = new MaximoSeedService(
    prisma.asService(),
    new MaximoStagingService(prisma.asService()),
    silentLogger(),
  );
  await seed.seedFixtures();
  return prisma;
}

describe('MaximoRemapService', () => {
  it('actualiza columnas mapeadas y mapper_version desde raw, sin red', async () => {
    const prisma = await seededPrisma();
    // Simula filas escritas por un mapper anterior con datos desalineados
    for (const row of prisma.maximo_purchase_orders.rows) {
      row.mapper_version = '2000.01.01-0';
      row.ab_clasfpo = 'DESALINEADO';
    }
    for (const row of prisma.maximo_contracts.rows) {
      row.mapper_version = '2000.01.01-0';
    }

    const remap = new MaximoRemapService(prisma.asService(), silentLogger());
    const po = await remap.remapAll('purchase_orders');
    expect(po.failed).toBe(0);
    expect(po.scanned).toBe(prisma.maximo_purchase_orders.rows.length);
    expect(po.remapped).toBe(po.scanned);
    expect(
      prisma.maximo_purchase_orders.rows.every(
        (r) => r.mapper_version === MAXIMO_MAPPER_VERSION,
      ),
    ).toBe(true);
    // El valor desalineado volvió a derivarse del raw
    const po102249 = prisma.maximo_purchase_orders.rows.find(
      (r) => r.ponum === 'PO102249',
    )!;
    expect(po102249.ab_clasfpo).toBe('CAPEX');

    const contracts = await remap.remapAll('contracts');
    expect(contracts.failed).toBe(0);
    expect(contracts.remapped).toBe(prisma.maximo_contracts.rows.length);
    expect(
      prisma.maximo_contracts.rows.every(
        (r) => r.mapper_version === MAXIMO_MAPPER_VERSION,
      ),
    ).toBe(true);
    // T3: cada fila de revisión re-encontró SU revisión dentro del raw completo
    const v1040 = prisma.maximo_contracts.rows.filter(
      (r) => r.contractnum === '1040',
    );
    expect(v1040.map((r) => [r.revisionnum, r.maxvol])).toEqual(
      expect.arrayContaining([
        [0, null],
        [1, 62385],
      ]),
    );
  });

  it('no toca raw, first_seen_at ni last_sync_run_id', async () => {
    const prisma = await seededPrisma();
    const before = prisma.maximo_purchase_orders.rows.map((r) => ({
      id: r.id,
      raw: JSON.stringify(r.raw),
      first_seen_at: r.first_seen_at,
      last_sync_run_id: r.last_sync_run_id,
    }));
    const remap = new MaximoRemapService(prisma.asService(), silentLogger());
    await remap.remapAll('purchase_orders');
    for (const b of before) {
      const after = prisma.maximo_purchase_orders.rows.find(
        (r) => r.id === b.id,
      )!;
      expect(JSON.stringify(after.raw)).toBe(b.raw);
      expect(after.first_seen_at).toEqual(b.first_seen_at);
      expect(after.last_sync_run_id).toBe(b.last_sync_run_id);
    }
  });
});
