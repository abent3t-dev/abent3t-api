import { MaximoRemapService } from './maximo-remap.service';
import { MaximoSeedService } from './maximo-seed.service';
import { MaximoStagingService, maximoRawHash } from './maximo-staging.service';
import { MAXIMO_MAPPER_VERSION, toContracts } from '../maximo.mapper';
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

  it('K8: usa las mismas columnas que staging (K2/K6 en OC, pr_* en contratos) y recalcula raw_hash', async () => {
    const prisma = await seededPrisma();
    for (const row of [
      ...prisma.maximo_purchase_orders.rows,
      ...prisma.maximo_contracts.rows,
    ]) {
      row.mapper_version = '2026.10.01-1';
      row.raw_hash = 'hash-anterior';
    }
    const po104896 = prisma.maximo_purchase_orders.rows.find(
      (r) => r.ponum === 'PO104896',
    )!;
    po104896.integration_status = null;
    po104896.subtotal = null;
    for (const row of prisma.maximo_contracts.rows) {
      row.pr_status = null;
      row.pr_approved_at = null;
    }

    const remap = new MaximoRemapService(prisma.asService(), silentLogger());
    expect((await remap.remapAll('purchase_orders')).failed).toBe(0);
    expect((await remap.remapAll('contracts')).failed).toBe(0);

    expect(po104896.integration_status).toBe('PROCESADO');
    expect(po104896.subtotal).toBe(1755);
    const pr6 = prisma.maximo_contracts.rows.filter(
      (r) => r.prnum === 'PR990006',
    );
    expect(pr6).toHaveLength(2);
    for (const row of pr6) {
      expect(row.pr_status).toBe('CLOSE');
      expect(row.pr_approved_at).toEqual(new Date('2026-06-11T09:00:00+00:00'));
    }
    for (const row of [
      ...prisma.maximo_purchase_orders.rows,
      ...prisma.maximo_contracts.rows,
    ]) {
      expect(row.raw_hash).toBe(maximoRawHash(row.raw));
    }
  });

  it('no toca raw, first_seen_at, last_seen_at, last_changed_at, last_sync_run_id ni superseded_at', async () => {
    const prisma = await seededPrisma();
    const snapshot = (rows: Array<Record<string, unknown> & { id: string }>) =>
      rows.map((r) => ({
        id: r.id,
        raw: JSON.stringify(r.raw),
        first_seen_at: r.first_seen_at,
        last_seen_at: r.last_seen_at,
        last_changed_at: r.last_changed_at,
        last_sync_run_id: r.last_sync_run_id,
        superseded_at: r.superseded_at,
      }));
    // una revisión obsoleta: remap no la limpia ni la marca
    const stale = prisma.maximo_contracts.rows[0];
    stale.superseded_at = new Date('2026-10-01T00:00:00Z');
    const beforePo = snapshot(prisma.maximo_purchase_orders.rows);
    const beforeContracts = snapshot(prisma.maximo_contracts.rows);

    const remap = new MaximoRemapService(prisma.asService(), silentLogger());
    await remap.remapAll('purchase_orders');
    await remap.remapAll('contracts');
    expect(snapshot(prisma.maximo_purchase_orders.rows)).toEqual(beforePo);
    expect(snapshot(prisma.maximo_contracts.rows)).toEqual(beforeContracts);
  });

  it.each([
    ['menor', 'la recorre primero'],
    ['mayor', 'la recorre al final'],
  ])(
    'K8: con la fila vieja de id %s que la buena (%s), el historial de la PR sale de la vigente y superseded_at no cambia',
    async (oldIdIs) => {
      const prisma = new FakePrisma();
      const staging = new MaximoStagingService(prisma.asService());
      // Fila vieja sin contrato (historial corto) y después la PR con
      // contrato (historial completo): el sync marca la vieja como obsoleta
      const noContract = remapPr({ withContract: false });
      for (const dto of toContracts(noContract)) {
        await staging.upsertContract(dto, noContract, 'run-1');
      }
      const withContract = remapPr({ withContract: true });
      const dtos = toContracts(withContract);
      for (const dto of dtos) {
        await staging.upsertContract(dto, withContract, 'run-2');
      }
      await staging.supersedeMissingRevisions('PR-REMAP', dtos);

      const old = prisma.maximo_contracts.rows.find(
        (r) => r.contractnum === null,
      )!;
      const good = prisma.maximo_contracts.rows.find(
        (r) => r.contractnum === 'C1',
      )!;
      // uuid al azar: el orden del recorrido no debe decidir el historial
      old.id =
        oldIdIs === 'menor'
          ? '00000000-0000-4000-8000-0000000000a1'
          : 'ffffffff-ffff-4fff-bfff-fffffffffff1';
      good.id = '80000000-0000-4000-8000-000000000001';
      const supersededAt = old.superseded_at;
      expect(supersededAt).toEqual(expect.any(Object));
      prisma.maximo_pr_status_history.rows = [];

      const remap = new MaximoRemapService(prisma.asService(), silentLogger());
      const result = await remap.remapAll('contracts');
      expect(result).toMatchObject({ scanned: 2, remapped: 2, failed: 0 });

      const history = prisma.maximo_pr_status_history.rows
        .filter((h) => h.prnum === 'PR-REMAP')
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      expect(history.map((h) => h.status)).toEqual(['WAPPR', 'APPR', 'CLOSE']);
      expect(old.superseded_at).toEqual(supersededAt);
      expect(good.superseded_at).toBeNull();
    },
  );

  it('G6: reescribe el historial POSTATUS de cada OC (sin duplicar al repetir)', async () => {
    const prisma = await seededPrisma();
    const remap = new MaximoRemapService(prisma.asService(), silentLogger());
    await remap.remapAll('purchase_orders');
    const firstRun = prisma.maximo_po_status_history.rows.length;
    expect(firstRun).toBeGreaterThan(0);
    await remap.remapAll('purchase_orders');
    expect(prisma.maximo_po_status_history.rows.length).toBe(firstRun);

    const po102249 = prisma.maximo_purchase_orders.rows.find(
      (r) => r.ponum === 'PO102249',
    )!;
    const history = prisma.maximo_po_status_history.rows
      .filter((h) => h.po_id === po102249.id)
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    expect(history.map((h) => h.seq)).toEqual(history.map((_, i) => i));
    expect(history.some((h) => h.status === 'WAPPR')).toBe(true);
    expect(history.every((h) => h.ponum === 'PO102249')).toBe(true);
    // G2/G3: columnas de la solicitud derivadas del raw
    expect(po102249.pr_nums).toEqual(['PR102826']);
    expect(po102249.pr_issue_date).toEqual(
      new Date('2026-06-05T12:35:06+00:00'),
    );
  });
});

/**
 * PR compacta para el remap: sin contrato solo llegó a WAPPR; con contrato ya
 * trae WAPPR → APPR → CLOSE (otro rowstamp de la raíz).
 */
function remapPr({ withContract }: { withContract: boolean }): unknown {
  const history = [
    {
      STATUS: 'WAPPR',
      CHANGEDATE: '2026-09-01T10:00:00+00:00',
      CHANGEBY: 'USR021',
      PRSTATUSID: 1,
    },
    {
      STATUS: 'APPR',
      CHANGEDATE: '2026-09-02T10:00:00+00:00',
      CHANGEBY: 'USR023',
      PRSTATUSID: 2,
    },
    {
      STATUS: 'CLOSE',
      CHANGEDATE: '2026-09-20T10:00:00+00:00',
      CHANGEBY: 'USR024',
      PRSTATUSID: 3,
    },
  ];
  return {
    rowstamp: withContract ? 'PR-REMAP-ROOT-2' : 'PR-REMAP-ROOT-1',
    PRNUM: 'PR-REMAP',
    SITEID: 'A3T',
    STATUS: withContract ? 'CLOSE' : 'WAPPR',
    PRSTATUS: withContract ? history : history.slice(0, 1),
    ...(withContract
      ? {
          PURCHVIEW: [
            { rowstamp: 'PV-REMAP', CONTRACTNUM: 'C1', REVISIONNUM: 0 },
          ],
        }
      : {}),
  };
}
