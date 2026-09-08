import { MaximoClient, MaximoFetchResult } from '../maximo.client';
import { MaximoConfig } from '../maximo.config';
import { MaximoPurchaseOrderDto } from '../dto/maximo-po.dto';
import { MAXIMO_MAPPER_VERSION } from '../maximo.mapper';
import { MaximoStagingService } from './maximo-staging.service';
import { MaximoSyncService } from './maximo-sync.service';
import { MaximoSyncConfig } from './maximo-sync.config';
import {
  MaximoSyncDisabledError,
  MaximoSyncInProgressError,
} from './maximo-sync.errors';
import { isSyncSkipped, MaximoSyncRunSummary } from './maximo-sync.types';
import {
  contractPageFromFixture,
  FakePrisma,
  fixture,
  poPageFromLegacyFixture,
  silentLogger,
} from './testing/maximo-sync.testkit';

/**
 * Fase INT-3. Motor de sync probado con MaximoClient MOCKEADO sobre fixtures
 * y Prisma en memoria: cero llamadas de red, cero base real.
 */

type PoPage = MaximoFetchResult<MaximoPurchaseOrderDto>;

interface Harness {
  service: MaximoSyncService;
  prisma: FakePrisma;
  client: {
    fetchPurchaseOrders: jest.Mock;
    fetchContracts: jest.Mock;
  };
  lines: string[];
}

function makeService(
  overrides: {
    sync?: Partial<MaximoSyncConfig>;
    maximo?: Partial<MaximoConfig>;
  } = {},
): Harness {
  const prisma = new FakePrisma();
  const lines: string[] = [];
  const client = {
    fetchPurchaseOrders: jest.fn(),
    fetchContracts: jest.fn(),
  };
  const syncConfig: MaximoSyncConfig = {
    enabled: true,
    intervalMinutes: 60,
    pageSize: 2,
    ...overrides.sync,
  };
  const maximoConfig: MaximoConfig = {
    baseUrl: 'http://maximo.test/os',
    oslcUrl: 'http://maximo.test/oslc',
    authToken: 'fake',
    contractsEnabled: true,
    timeoutMs: 1000,
    maxRetries: 0,
    ...overrides.maximo,
  };
  const service = new MaximoSyncService(
    prisma.asService(),
    client as unknown as MaximoClient,
    new MaximoStagingService(prisma.asService()),
    syncConfig,
    maximoConfig,
    silentLogger(lines),
  );
  return { service, prisma, client, lines };
}

/** Divide los 3 POs del fixture de rango en páginas de 2 con rsTotal real. */
function rangePages(): [PoPage, PoPage] {
  const all = poPageFromLegacyFixture('ab-compras.legacy-compact.range.json');
  const page1: PoPage = {
    ...all,
    records: all.records.slice(0, 2),
    raw: all.raw.slice(0, 2),
    legacyPage: { rsStart: 0, rsCount: 2, rsTotal: 3 },
  };
  const page2: PoPage = {
    ...all,
    records: all.records.slice(2),
    raw: all.raw.slice(2),
    legacyPage: { rsStart: 2, rsCount: 1, rsTotal: 3 },
  };
  return [page1, page2];
}

const summaryOf = (r: MaximoSyncRunSummary) => ({
  status: r.status,
  inserted: r.recordsInserted,
  updated: r.recordsUpdated,
  unchanged: r.recordsUnchanged,
  failed: r.recordsFailed,
});

describe('MaximoSyncService — AB_COMPRAS', () => {
  it('primera corrida inserta N; la segunda idéntica deja N unchanged y 0 updated', async () => {
    const { service, prisma, client } = makeService();
    const [p1, p2] = rangePages();
    client.fetchPurchaseOrders
      .mockResolvedValueOnce(p1)
      .mockResolvedValueOnce(p2);

    const first = await service.syncPurchaseOrders('manual', 'user-1');
    expect(summaryOf(first)).toEqual({
      status: 'success',
      inserted: 3,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(first.pagesOk).toBe(2);
    expect(first.pagesTotal).toBe(2);
    expect(client.fetchPurchaseOrders).toHaveBeenCalledTimes(2);
    expect(client.fetchPurchaseOrders).toHaveBeenNthCalledWith(1, {
      maxItems: 2,
      rsStart: 0,
    });
    expect(client.fetchPurchaseOrders).toHaveBeenNthCalledWith(2, {
      maxItems: 2,
      rsStart: 2,
    });
    expect(prisma.maximo_purchase_orders.rows).toHaveLength(3);
    const row = prisma.maximo_purchase_orders.rows.find(
      (r) => r.ponum === 'PO102249',
    )!;
    expect(row.ab_clasfpo).toBe('CAPEX');
    expect(row.mapper_version).toBe(MAXIMO_MAPPER_VERSION);
    expect(row.raw).toBeDefined();
    expect(row.last_sync_run_id).toBe(first.runId);

    // Corrida en la bitácora
    const run = prisma.maximo_sync_runs.rows.find((r) => r.id === first.runId)!;
    expect(run.status).toBe('success');
    expect(run.records_inserted).toBe(3);
    expect(run.triggered_by).toBe('manual');
    expect(run.triggered_by_user_id).toBe('user-1');
    expect(run.finished_at).toBeDefined();

    const [q1, q2] = rangePages();
    client.fetchPurchaseOrders
      .mockResolvedValueOnce(q1)
      .mockResolvedValueOnce(q2);
    const second = await service.syncPurchaseOrders('cron');
    expect(summaryOf(second)).toEqual({
      status: 'success',
      inserted: 0,
      updated: 0,
      unchanged: 3,
      failed: 0,
    });
    expect(prisma.maximo_purchase_orders.rows).toHaveLength(3);
  });

  it('rowstamp cambiado → 1 updated con raw reemplazado y last_changed_at', async () => {
    const { service, prisma, client } = makeService({
      sync: { pageSize: 100 },
    });
    const base = poPageFromLegacyFixture(
      'ab-compras.legacy-compact.po102249.json',
    );
    client.fetchPurchaseOrders.mockResolvedValueOnce(base);
    await service.syncPurchaseOrders('manual');

    // Mismo PO con rowstamp nuevo y monto cambiado (Maximo mutó la fila).
    const rawChanged = structuredClone(base.raw[0]) as Record<string, unknown>;
    rawChanged.rowstamp = '999999999';
    rawChanged.TOTALCOST = 111111.11;
    const changed = poPageFromLegacyFixture(
      'ab-compras.legacy-compact.po102249.json',
    );
    changed.raw = [rawChanged];
    changed.records = [
      { ...changed.records[0], rowstamp: '999999999', totalCost: 111111.11 },
    ];
    client.fetchPurchaseOrders.mockResolvedValueOnce(changed);

    const second = await service.syncPurchaseOrders('manual');
    expect(summaryOf(second)).toEqual({
      status: 'success',
      inserted: 0,
      updated: 1,
      unchanged: 0,
      failed: 0,
    });
    const row = prisma.maximo_purchase_orders.rows[0];
    expect(row.rowstamp).toBe('999999999');
    expect(Number(row.total_cost)).toBe(111111.11);
    expect((row.raw as Record<string, unknown>).rowstamp).toBe('999999999');
    expect(row.last_changed_at).toBeDefined();
  });

  it('página que falla → corrida partial, las demás páginas persistidas', async () => {
    const { service, prisma, client } = makeService();
    const [p1, p2] = rangePages();
    // rsTotal=5 para forzar 3 páginas: ok, FALLA, ok
    p1.legacyPage = { rsStart: 0, rsCount: 2, rsTotal: 5 };
    client.fetchPurchaseOrders
      .mockResolvedValueOnce(p1)
      .mockRejectedValueOnce(new Error('ECONNRESET simulado'))
      .mockResolvedValueOnce(p2);

    const result = await service.syncPurchaseOrders('manual');
    expect(result.status).toBe('partial');
    expect(result.pagesOk).toBe(2);
    expect(result.pagesFailed).toBe(1);
    expect(result.recordsInserted).toBe(3);
    expect(result.errorSummary).toContain('rsStart=2');
    expect(result.errorSummary).toContain('ECONNRESET simulado');
    expect(prisma.maximo_purchase_orders.rows).toHaveLength(3);
    const run = prisma.maximo_sync_runs.rows[0];
    expect(run.status).toBe('partial');
  });

  it('página CORTA con rsTotal restante NO termina el escaneo (H5: parámetros ignorados en silencio)', async () => {
    const { service, prisma, client } = makeService();
    const [p1, p2] = rangePages();
    // El "servidor" entrega 1 en vez de 2 por página; rsTotal=3 manda.
    const short1 = {
      ...p1,
      records: p1.records.slice(0, 1),
      raw: p1.raw.slice(0, 1),
      legacyPage: { rsStart: 0, rsCount: 1, rsTotal: 3 },
    };
    const short2 = {
      ...p1,
      records: p1.records.slice(1, 2),
      raw: p1.raw.slice(1, 2),
      legacyPage: { rsStart: 1, rsCount: 1, rsTotal: 3 },
    };
    client.fetchPurchaseOrders
      .mockResolvedValueOnce(short1)
      .mockResolvedValueOnce(short2)
      .mockResolvedValueOnce(p2);

    const result = await service.syncPurchaseOrders('manual');
    expect(result.status).toBe('success');
    expect(result.recordsInserted).toBe(3);
    expect(client.fetchPurchaseOrders).toHaveBeenCalledTimes(3);
    // Avanza lo realmente recibido, no el pageSize solicitado
    expect(client.fetchPurchaseOrders).toHaveBeenNthCalledWith(2, {
      maxItems: 2,
      rsStart: 1,
    });
    expect(prisma.maximo_purchase_orders.rows).toHaveLength(3);
  });

  it('página VACÍA con rsTotal restante → truncamiento explícito: corrida partial', async () => {
    const { service, client } = makeService();
    const [p1] = rangePages();
    p1.legacyPage = { rsStart: 0, rsCount: 2, rsTotal: 10 };
    const empty = { ...p1, records: [], raw: [] };
    client.fetchPurchaseOrders
      .mockResolvedValueOnce(p1)
      .mockResolvedValueOnce(empty);

    const result = await service.syncPurchaseOrders('manual');
    expect(result.status).toBe('partial');
    expect(result.errorSummary).toContain('página vacía');
    expect(result.recordsInserted).toBe(2);
  });

  it('zombie cleanup al arrancar: corridas running viejas quedan failed', async () => {
    const { service, prisma } = makeService();
    await prisma.maximo_sync_runs.create({
      data: {
        target: 'purchase_orders',
        triggered_by: 'cron',
        mapper_version: 'v',
        started_at: new Date(Date.now() - 60 * 60_000), // hace 1 h
      },
    });
    await prisma.maximo_sync_runs.create({
      data: {
        target: 'contracts',
        triggered_by: 'cron',
        mapper_version: 'v',
        started_at: new Date(), // reciente: se respeta
      },
    });

    await service.onModuleInit();
    const [old, recent] = prisma.maximo_sync_runs.rows;
    expect(old.status).toBe('failed');
    expect(String(old.error_summary)).toContain('zombie');
    expect(recent.status).toBe('running');
  });

  it('todas las páginas fallan sin total conocido → failed tras 3 intentos', async () => {
    const { service, client, prisma } = makeService();
    client.fetchPurchaseOrders.mockRejectedValue(new Error('caído'));
    const result = await service.syncPurchaseOrders('manual');
    expect(result.status).toBe('failed');
    expect(result.pagesOk).toBe(0);
    expect(result.pagesFailed).toBe(3);
    expect(client.fetchPurchaseOrders).toHaveBeenCalledTimes(3);
    expect(prisma.maximo_purchase_orders.rows).toHaveLength(0);
  });

  it('filterCheck no aplicado → queda en filter_warnings de la corrida', async () => {
    const { service, prisma, client } = makeService({
      sync: { pageSize: 100 },
    });
    const page = poPageFromLegacyFixture(
      'ab-compras.legacy-compact.po102249.json',
    );
    page.filterCheck = {
      kind: 'range',
      applied: false,
      violations: 1,
      unverifiable: 0,
      description: 'fuera de rango',
    };
    client.fetchPurchaseOrders.mockResolvedValueOnce(page);
    const result = await service.syncPurchaseOrders('manual');
    expect(result.filterWarnings).toHaveLength(1);
    const run = prisma.maximo_sync_runs.rows[0];
    expect(run.filter_warnings).toBeDefined();
  });

  it('MAXIMO_SYNC_ENABLED=false → MaximoSyncDisabledError sin tocar cliente ni crear corrida', async () => {
    const { service, prisma, client } = makeService({
      sync: { enabled: false },
    });
    await expect(service.syncPurchaseOrders('manual')).rejects.toBeInstanceOf(
      MaximoSyncDisabledError,
    );
    expect(client.fetchPurchaseOrders).not.toHaveBeenCalled();
    expect(prisma.maximo_sync_runs.rows).toHaveLength(0);
  });

  it('mutex: corrida solapada del mismo target rechazada; targets distintos concurren', async () => {
    const { service, client } = makeService();
    let releasePo!: (page: PoPage) => void;
    client.fetchPurchaseOrders.mockReturnValueOnce(
      new Promise<PoPage>((resolve) => {
        releasePo = resolve;
      }),
    );
    client.fetchContracts.mockResolvedValue(
      contractPageFromFixture('ab-contratos.legacy-compact.pr102828.json'),
    );

    const inFlight = service.syncPurchaseOrders('manual');
    await Promise.resolve(); // deja que la primera adquiera el mutex
    expect(service.isRunning('purchase_orders')).toBe(true);

    await expect(service.syncPurchaseOrders('manual')).rejects.toBeInstanceOf(
      MaximoSyncInProgressError,
    );
    // Target distinto SÍ concurre
    const contracts = await service.syncContracts('manual');
    expect(isSyncSkipped(contracts)).toBe(false);

    const [p1] = rangePages();
    p1.legacyPage = { rsStart: 0, rsCount: 2, rsTotal: 2 };
    releasePo(p1);
    const done = await inFlight;
    expect(done.status).toBe('success');
    expect(service.isRunning('purchase_orders')).toBe(false);
  });
});

describe('MaximoSyncService — AB_CONTRATOS (T3)', () => {
  it('PR sin contrato y PR con 2 PURCHVIEW → 1 fila has_contract=false y 2 filas purchview_count=2', async () => {
    const { service, prisma, client } = makeService({
      sync: { pageSize: 100 },
    });
    const twoRevisions = {
      rowstamp: 'PR-ROOT-1',
      PRNUM: 'PR-MULTI',
      REQUESTEDBY: 'MAXADMIN',
      SITEID: 'A3T',
      PURCHVIEW: [
        {
          rowstamp: 'PV-A',
          CONTRACTNUM: '9001',
          REVISIONNUM: 0,
          TOTALCOST: 10,
        },
        {
          rowstamp: 'PV-B',
          CONTRACTNUM: '9001',
          REVISIONNUM: 1,
          TOTALCOST: 20,
        },
      ],
    };
    const noContract = parseNoContractRecord();
    const page = contractPageFromFixture(
      'ab-contratos.legacy-compact.pr102828.json',
    );
    page.raw = [twoRevisions, noContract];
    page.legacyPage = { rsStart: 0, rsCount: 2, rsTotal: 2 };
    client.fetchContracts.mockResolvedValueOnce(page);

    const result = await service.syncContracts('manual');
    if (isSyncSkipped(result)) throw new Error('no debió omitirse');
    expect(summaryOf(result)).toEqual({
      status: 'success',
      inserted: 3,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });

    const rows = prisma.maximo_contracts.rows;
    expect(rows).toHaveLength(3);
    const multi = rows.filter((r) => r.prnum === 'PR-MULTI');
    expect(multi).toHaveLength(2);
    expect(multi.map((r) => r.revisionnum).sort()).toEqual([0, 1]);
    expect(multi.every((r) => r.purchview_count === 2)).toBe(true);
    expect(multi.every((r) => r.has_contract === true)).toBe(true);
    // T4/T3: detección de cambios por la fila PURCHVIEW
    expect(multi.map((r) => r.contract_rowstamp).sort()).toEqual([
      'PV-A',
      'PV-B',
    ]);

    const sinContrato = rows.find((r) => r.prnum === 'PR100026')!;
    expect(sinContrato.has_contract).toBe(false);
    expect(sinContrato.contractnum).toBeNull();
    // Ambas filas comparten el MISMO raw completo del PR (T3 documentado)
    expect(multi[0].raw).toEqual(multi[1].raw);
  });

  it('con MAXIMO_CONTRACTS_ENABLED=false la corrida se omite con log informativo (sin corrida, sin red)', async () => {
    const { service, prisma, client, lines } = makeService({
      maximo: { contractsEnabled: false },
    });
    const result = await service.syncContracts('cron');
    expect(isSyncSkipped(result)).toBe(true);
    expect(client.fetchContracts).not.toHaveBeenCalled();
    expect(prisma.maximo_sync_runs.rows).toHaveLength(0);
    expect(lines.join('\n')).toContain('MAXIMO_CONTRACTS_ENABLED=false');
  });
});

function parseNoContractRecord(): unknown {
  const body = fixture('ab-contratos.legacy-nested.no-contract.json') as {
    QueryAB_CONTRATOSResponse: { AB_CONTRATOSSet: { PR: unknown[] } };
  };
  return body.QueryAB_CONTRATOSResponse.AB_CONTRATOSSet.PR[0];
}
