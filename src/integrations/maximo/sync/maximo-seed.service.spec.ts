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
    expect(second.purchaseOrders.remapped).toBe(0);
    expect(second.contracts.inserted).toBe(0);
    expect(second.contracts.updated).toBe(0);
    expect(second.contracts.remapped).toBe(0);
    expect(second.purchaseOrders.unchanged).toBeGreaterThan(0);
    // lo sembrado antes es del seed: la segunda corrida no lo salta
    expect(first.purchaseOrders.skipped).toBe(0);
    expect(first.contracts.skipped).toBe(0);
    expect(second.purchaseOrders.skipped).toBe(0);
    expect(second.contracts.skipped).toBe(0);
  });

  it('no pisa datos reales: la OC o la PR con filas de una corrida real se salta completa (sin obsoletas ni historial del fixture) y el clear no la toca', async () => {
    process.env.NODE_ENV = 'test';
    const { prisma, seed } = makeSeed();
    // Filas "reales" (otra corrida) de una OC y de una PR que también vienen
    // en los fixtures. La PR real tiene una fila sin contrato que el fixture
    // no trae: el sync la marcaría obsoleta; el seed no debe.
    prisma.maximo_purchase_orders.rows.push({
      id: 'po-real',
      ponum: 'PO104896',
      siteid: 'A3T',
      revisionnum: 0,
      raw: { real: true },
      last_sync_run_id: 'run-real-1',
    });
    prisma.maximo_contracts.rows.push({
      id: 'pr-real',
      prnum: 'PR990006',
      contractnum: null,
      revisionnum: 0,
      has_contract: false,
      raw: { real: true },
      last_sync_run_id: 'run-real-1',
      superseded_at: null,
    });
    prisma.maximo_pr_status_history.rows.push({
      id: 'h-real',
      prnum: 'PR990006',
      seq: 0,
      status: 'WAPPR',
    });
    const logs: string[] = [];
    const seedWithLog = new MaximoSeedService(
      prisma.asService(),
      new MaximoStagingService(prisma.asService()),
      silentLogger(logs),
    );

    const result = await seedWithLog.seedFixtures();
    expect(result.purchaseOrders).toMatchObject({ skipped: 1, failed: 0 });
    // PR990006 viene en la forma anidada y en la compacta
    expect(result.contracts).toMatchObject({ skipped: 2, failed: 0 });
    expect(
      logs.some((l) => l.includes('skipped=2') && l.includes('PR990006')),
    ).toBe(true);

    const pr6 = prisma.maximo_contracts.rows.filter(
      (r) => r.prnum === 'PR990006',
    );
    expect(pr6).toHaveLength(1);
    expect(pr6[0]).toMatchObject({
      id: 'pr-real',
      raw: { real: true },
      superseded_at: null,
    });
    expect(
      prisma.maximo_pr_status_history.rows
        .filter((h) => h.prnum === 'PR990006')
        .map((h) => h.id),
    ).toEqual(['h-real']);
    const po = prisma.maximo_purchase_orders.rows.filter(
      (r) => r.ponum === 'PO104896',
    );
    expect(po).toHaveLength(1);
    expect(po[0].raw).toEqual({ real: true });
    // el resto de los fixtures se siembra igual
    expect(
      prisma.maximo_contracts.rows.some((r) => r.prnum === 'PR990002'),
    ).toBe(true);

    await seed.clearSeeds();
    expect(prisma.maximo_purchase_orders.rows.map((r) => r.id)).toEqual([
      'po-real',
    ]);
    expect(prisma.maximo_contracts.rows.map((r) => r.id)).toEqual(['pr-real']);
    expect(prisma.maximo_pr_status_history.rows.map((h) => h.id)).toEqual([
      'h-real',
    ]);
  });

  it('K8: cuenta remapped aparte (mapper nuevo con el mismo rowstamp) y la corrida seed lo guarda', async () => {
    process.env.NODE_ENV = 'test';
    const { prisma, seed } = makeSeed();
    const first = await seed.seedFixtures();
    for (const row of [
      ...prisma.maximo_purchase_orders.rows,
      ...prisma.maximo_contracts.rows,
    ]) {
      row.mapper_version = '2026.10.01-1';
    }

    const second = await seed.seedFixtures();
    // cada fila se re-mapea una vez; su copia por otra API/forma ya sale igual
    expect(second.purchaseOrders).toMatchObject({
      inserted: 0,
      updated: 0,
      remapped: prisma.maximo_purchase_orders.rows.length,
      unchanged: first.purchaseOrders.unchanged,
      failed: 0,
    });
    expect(second.contracts).toMatchObject({
      inserted: 0,
      updated: 0,
      remapped: prisma.maximo_contracts.rows.length,
      unchanged: first.contracts.unchanged,
      failed: 0,
    });
    const run = prisma.maximo_sync_runs.rows.find(
      (r) => r.id === second.contracts.runId,
    )!;
    expect(run.records_remapped).toBe(second.contracts.remapped);
    expect(run.records_updated).toBe(0);
  });

  it('K8: cuenta las revisiones que marca obsoletas y el log trae siempre skipped (y superseded en contratos), también en 0', async () => {
    process.env.NODE_ENV = 'test';
    const prisma = new FakePrisma();
    // Siembra anterior (corrida seed) con PR990006 aún sin contrato: el
    // fixture de hoy trae sus dos revisiones del contrato 9906
    prisma.maximo_sync_runs.rows.push({
      id: 'run-seed-0',
      target: 'contracts',
      triggered_by: 'seed',
      status: 'success',
    });
    prisma.maximo_contracts.rows.push({
      id: 'pr6-sin-contrato',
      prnum: 'PR990006',
      contractnum: null,
      revisionnum: 0,
      has_contract: false,
      raw: { seed: 'anterior' },
      last_sync_run_id: 'run-seed-0',
      superseded_at: null,
    });
    const logs: string[] = [];
    const seed = new MaximoSeedService(
      prisma.asService(),
      new MaximoStagingService(prisma.asService()),
      silentLogger(logs),
    );

    const result = await seed.seedFixtures();
    // la marca es una sola vez: la forma compacta ya la encuentra marcada
    expect(result.contracts).toMatchObject({
      skipped: 0,
      superseded: 1,
      failed: 0,
    });
    expect(result.purchaseOrders.superseded).toBe(0);
    const old = prisma.maximo_contracts.rows.find(
      (r) => r.id === 'pr6-sin-contrato',
    )!;
    expect(old.superseded_at).toEqual(expect.any(Object));

    const poLine = logs.find((l) => l.includes('seed(purchase_orders)'))!;
    const contractLine = logs.find((l) => l.includes('seed(contracts)'))!;
    expect(poLine).toContain('failed=0 skipped=0');
    expect(poLine).not.toContain('superseded=');
    expect(contractLine).toContain('failed=0 skipped=0 superseded=1');

    // la segunda siembra no vuelve a marcar nada
    logs.length = 0;
    const second = await seed.seedFixtures();
    expect(second.contracts.superseded).toBe(0);
    expect(logs.find((l) => l.includes('seed(contracts)'))).toContain(
      'skipped=0 superseded=0',
    );
  });

  it('K2/K3/K6: siembra PO104896 con PO5 y subtotal, y las PR con pr_* e historial (las dos formas dan una sola copia)', async () => {
    process.env.NODE_ENV = 'test';
    const { prisma, seed } = makeSeed();
    const result = await seed.seedFixtures();
    expect(result.contracts.failed).toBe(0);

    const po = prisma.maximo_purchase_orders.rows.find(
      (r) => r.ponum === 'PO104896',
    )!;
    expect(po.integration_status).toBe('PROCESADO');
    expect(po.subtotal).toBe(1755);
    expect(po.pr_nums).toEqual(['PR990001', 'PR990007']);

    const prs = prisma.maximo_contracts.rows.filter((r) =>
      String(r.prnum).startsWith('PR9900'),
    );
    // 7 PR, PR990006 con dos revisiones; la forma compacta no duplica
    expect(prs).toHaveLength(8);
    expect(prs.every((r) => r.pr_status !== null)).toBe(true);
    expect(prs.every((r) => r.superseded_at === null)).toBe(true);
    const pr2 = prs.find((r) => r.prnum === 'PR990002')!;
    expect(pr2.pr_status).toBe('APPR');
    expect(pr2.pr_approved_at).toEqual(new Date('2026-09-15T09:00:00+00:00'));

    const history = prisma.maximo_pr_status_history.rows;
    const keys = history.map((h) => `${String(h.prnum)}|${String(h.seq)}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      history
        .filter((h) => h.prnum === 'PR990002')
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map((h) => h.status),
    ).toEqual(['WAPPR', 'APPR', 'WAPPR', 'APPR']);
    expect(
      history.some(
        (h) => h.prnum === 'PR990003' && h.status === 'CAN' && h.memo,
      ),
    ).toBe(true);
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
    // K3: el historial de las PR (sin FK) también se va
    expect(cleared.prStatusHistory).toBeGreaterThan(0);
    expect(prisma.maximo_pr_status_history.rows).toHaveLength(0);
    // Las corridas quedan en la bitácora
    expect(prisma.maximo_sync_runs.rows).toHaveLength(2);
  });

  it('K3: clearSeeds conserva el historial de una PR con alguna revisión tocada por una corrida real', async () => {
    process.env.NODE_ENV = 'test';
    const { prisma, seed } = makeSeed();
    await seed.seedFixtures();
    const historyOf = (prnum: string) =>
      prisma.maximo_pr_status_history.rows.filter((h) => h.prnum === prnum);
    const pr6History = historyOf('PR990006').length;
    expect(pr6History).toBe(3);

    // Una de las dos revisiones de PR990006 la tocó una corrida real
    prisma.maximo_contracts.rows.find(
      (r) => r.prnum === 'PR990006',
    )!.last_sync_run_id = 'run-real-1';

    await seed.clearSeeds();
    expect(prisma.maximo_contracts.rows.map((r) => r.prnum)).toEqual([
      'PR990006',
    ]);
    expect(historyOf('PR990006')).toHaveLength(pr6History);
    expect(historyOf('PR990003')).toHaveLength(0);
  });
});
