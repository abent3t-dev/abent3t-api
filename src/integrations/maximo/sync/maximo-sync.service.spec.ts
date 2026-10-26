import { MaximoClient, MaximoFetchResult } from '../maximo.client';
import { MaximoConfig } from '../maximo.config';
import { MaximoPurchaseOrderDto } from '../dto/maximo-po.dto';
import {
  MAXIMO_MAPPER_VERSION,
  parseOslcEnvelope,
  toPurchaseOrder,
} from '../maximo.mapper';
import { MaximoStagingService, maximoRawHash } from './maximo-staging.service';
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
  staging: MaximoStagingService;
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
  const staging = new MaximoStagingService(prisma.asService());
  const service = new MaximoSyncService(
    prisma.asService(),
    client as unknown as MaximoClient,
    staging,
    syncConfig,
    maximoConfig,
    silentLogger(lines),
  );
  return { service, prisma, staging, client, lines };
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
  remapped: r.recordsRemapped,
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
      remapped: 0,
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
      remapped: 0,
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
      remapped: 0,
      unchanged: 0,
      failed: 0,
    });
    const row = prisma.maximo_purchase_orders.rows[0];
    expect(row.rowstamp).toBe('999999999');
    expect(Number(row.total_cost)).toBe(111111.11);
    expect((row.raw as Record<string, unknown>).rowstamp).toBe('999999999');
    expect(row.last_changed_at).toBeDefined();
  });

  it('I9/K8: mismo rowstamp con un campo nuevo (RECEIPTS) → remapped por hash, raw reescrito y receipt_status mapeado, sin last_changed_at', async () => {
    const { service, prisma, client, lines } = makeService({
      sync: { pageSize: 100 },
    });
    const base = poPageFromLegacyFixture(
      'ab-compras.legacy-compact.po102249.json',
    );
    client.fetchPurchaseOrders.mockResolvedValueOnce(base);
    await service.syncPurchaseOrders('manual');
    const before = structuredClone(prisma.maximo_purchase_orders.rows[0]);
    expect(before.receipt_status).toBeNull();
    expect(before.raw_hash).toBe(maximoRawHash(base.raw[0]));

    // CIISA agrega RECEIPTS a AB_COMPRAS: Maximo NO cambia el rowstamp
    const rawWithReceipts = structuredClone(base.raw[0]) as Record<
      string,
      unknown
    >;
    rawWithReceipts.RECEIPTS = 'COMPLETE';
    const changed = poPageFromLegacyFixture(
      'ab-compras.legacy-compact.po102249.json',
    );
    changed.raw = [rawWithReceipts];
    changed.records = [toPurchaseOrder(rawWithReceipts)];
    expect(changed.records[0].rowstamp).toBe(base.records[0].rowstamp);
    client.fetchPurchaseOrders.mockResolvedValueOnce(changed);

    const second = await service.syncPurchaseOrders('manual');
    expect(summaryOf(second)).toEqual({
      status: 'success',
      inserted: 0,
      updated: 0,
      remapped: 1,
      unchanged: 0,
      failed: 0,
    });
    const row = prisma.maximo_purchase_orders.rows[0];
    expect(row.receipt_status).toBe('COMPLETE');
    expect((row.raw as Record<string, unknown>).RECEIPTS).toBe('COMPLETE');
    expect(row.raw_hash).not.toBe(before.raw_hash);
    // K8: no es un cambio real en Maximo
    expect(row.last_changed_at).toBeUndefined();
    expect(row.last_sync_run_id).toBe(second.runId);
    expect(lines.join('\n')).toContain(
      'por mapper=0, por hash=1 ej.: PO102249|',
    );

    // El mismo payload otra vez → unchanged
    const again = poPageFromLegacyFixture(
      'ab-compras.legacy-compact.po102249.json',
    );
    again.raw = [structuredClone(rawWithReceipts)];
    again.records = [toPurchaseOrder(rawWithReceipts)];
    client.fetchPurchaseOrders.mockResolvedValueOnce(again);
    const third = await service.syncPurchaseOrders('manual');
    expect(summaryOf(third)).toMatchObject({
      updated: 0,
      remapped: 0,
      unchanged: 1,
    });
  });

  it('I9/K8: filas previas a 0017 (sin raw_hash) o de otro mapper se re-mapean UNA vez (por hash / por mapper) y luego quedan unchanged', async () => {
    const { service, prisma, client, lines } = makeService({
      sync: { pageSize: 100 },
    });
    const page = () =>
      poPageFromLegacyFixture('ab-compras.legacy-compact.range.json');
    client.fetchPurchaseOrders.mockResolvedValueOnce(page());
    await service.syncPurchaseOrders('manual');
    const [a, b] = prisma.maximo_purchase_orders.rows;
    a.raw_hash = null;
    b.mapper_version = '2026.09.28-1';

    client.fetchPurchaseOrders.mockResolvedValueOnce(page());
    const second = await service.syncPurchaseOrders('cron');
    expect(summaryOf(second)).toMatchObject({
      updated: 0,
      remapped: 2,
      unchanged: 1,
    });
    expect(a.raw_hash).toEqual(expect.any(String));
    expect(b.mapper_version).toBe(MAXIMO_MAPPER_VERSION);
    expect(lines.join('\n')).toContain('remapped=2 (por mapper=1, por hash=1');
    const run = prisma.maximo_sync_runs.rows.find(
      (r) => r.id === second.runId,
    )!;
    expect(run.records_remapped).toBe(2);
    expect(run.records_updated).toBe(0);

    client.fetchPurchaseOrders.mockResolvedValueOnce(page());
    const third = await service.syncPurchaseOrders('cron');
    expect(summaryOf(third)).toMatchObject({
      updated: 0,
      remapped: 0,
      unchanged: 3,
    });
  });

  it('I9: el hash no depende de la forma de la API (legacy ≡ OSLC) pero sí detecta campos y valores nuevos', () => {
    const legacy = poPageFromLegacyFixture(
      'ab-compras.legacy-compact.po102249.json',
    ).raw[0] as Record<string, unknown>;
    const oslc = parseOslcEnvelope(fixture('ab-compras.oslc.po102249.json'))
      .records[0];
    expect(maximoRawHash(oslc)).toBe(maximoRawHash(legacy));

    expect(maximoRawHash({ ...legacy, RECEIPTS: 'PARTIAL' })).not.toBe(
      maximoRawHash(legacy),
    );
    expect(maximoRawHash({ ...legacy, TOTALCOST: 1 })).not.toBe(
      maximoRawHash(legacy),
    );
    // un campo nuevo que llega vacío no es un cambio de datos
    expect(maximoRawHash({ ...legacy, RECEIPTS: '~null~' })).toBe(
      maximoRawHash(legacy),
    );
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

  it('zombie cleanup al arrancar: toda corrida running anterior al arranque queda failed (F2)', async () => {
    const { service, prisma } = makeService();
    const processStart = Date.now() - process.uptime() * 1000;
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
        // cortada por un redeploy segundos antes del arranque: antes (umbral
        // de 30 min) se quedaba en running
        started_at: new Date(processStart - 5_000),
      },
    });
    await prisma.maximo_sync_runs.create({
      data: {
        target: 'contracts',
        triggered_by: 'manual',
        mapper_version: 'v',
        started_at: new Date(), // posterior al arranque: se respeta
      },
    });

    await service.onModuleInit();
    const [old, cut, current] = prisma.maximo_sync_runs.rows;
    expect(old.status).toBe('failed');
    expect(String(old.error_summary)).toContain('zombie');
    expect(cut.status).toBe('failed');
    expect(current.status).toBe('running');
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
      remapped: 0,
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

// ---------------------------------------------------------------------------
// K8 (2026-10-05): re-mapeo sin "cambio", hash estable y filas obsoletas
// ---------------------------------------------------------------------------

const PO5_FIXTURE = 'ab-compras.legacy-nested.po5-linecost.SYNTHETIC.json';

/** Forma legacy anidada (Attributes / RelatedMbos) del fixture de PO104896. */
interface NestedMbo {
  rowstamp?: string;
  Attributes: Record<string, { content: unknown }>;
  RelatedMbos?: Record<string, NestedMbo[]>;
}

function po5Raw(): NestedMbo {
  return structuredClone(
    poPageFromLegacyFixture(PO5_FIXTURE).raw[0],
  ) as NestedMbo;
}

function related(mbo: NestedMbo, key: string): NestedMbo[] {
  const list = mbo.RelatedMbos?.[key];
  if (!list) throw new Error(`el fixture no trae ${key}`);
  return list;
}

/** Página de una sola OC (sin rsTotal: termina por página corta). */
function poPageOf(raw: unknown): PoPage {
  const page = poPageFromLegacyFixture(PO5_FIXTURE);
  page.raw = [raw];
  page.records = [toPurchaseOrder(raw)];
  page.legacyPage = { rsStart: 0, rsCount: 1, rsTotal: null };
  return page;
}

/** Página de contratos con registros compactos armados en la prueba. */
function contractPageOf(...raws: unknown[]): MaximoFetchResult<unknown> {
  const page = contractPageFromFixture(
    'ab-contratos.legacy-compact.pr102828.json',
  );
  page.raw = raws;
  page.legacyPage = { rsStart: 0, rsCount: raws.length, rsTotal: raws.length };
  return page;
}

/** PR compacta sin contrato; `withContract` le agrega una o más revisiones. */
function prRecord(
  prnum: string,
  options: { rowstamp?: string; revisions?: number[] } = {},
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    rowstamp: options.rowstamp ?? `${prnum}-ROOT-1`,
    PRNUM: prnum,
    SITEID: 'A3T',
    STATUS: 'APPR',
    ISSUEDATE: '2026-09-01T10:00:00+00:00',
    PRSTATUS: [
      {
        rowstamp: `${prnum}-S2`,
        STATUS: 'APPR',
        CHANGEDATE: '2026-09-02T10:00:00+00:00',
        CHANGEBY: 'USR023',
        PRSTATUSID: 2,
      },
      {
        rowstamp: `${prnum}-S1`,
        STATUS: 'WAPPR',
        CHANGEDATE: '2026-09-01T10:00:00+00:00',
        CHANGEBY: 'USR021',
        PRSTATUSID: 1,
      },
    ],
  };
  if (options.revisions) {
    record.PURCHVIEW = options.revisions.map((rev) => ({
      rowstamp: `${prnum}-PV-${rev}`,
      CONTRACTNUM: 'C1',
      REVISIONNUM: rev,
      TOTALCOST: 100 + rev,
    }));
  }
  return record;
}

describe('K8 — hash estable (maximoRawHash)', () => {
  it('reordenar hijos, cambiar el rowstamp de un hijo o un campo de PERSON/COMPANIES fuera de la proyección NO cambia el hash', () => {
    const hash = maximoRawHash(po5Raw());

    const reordered = po5Raw();
    related(reordered, 'POLINE').reverse();
    related(reordered, 'POSTATUS').reverse();
    expect(maximoRawHash(reordered)).toBe(hash);

    const childRowstamp = po5Raw();
    related(childRowstamp, 'POLINE')[0].rowstamp = '111111111';
    related(related(childRowstamp, 'POLINE')[0], 'PRLINE')[0].rowstamp =
      '222222222';
    expect(maximoRawHash(childRowstamp)).toBe(hash);

    // Editar el maestro de la persona o del proveedor (campos que el mapper
    // no lee) no re-mapea sus OC
    const person = po5Raw();
    related(person, 'PERSON')[0].Attributes.STATUS = { content: 'INACTIVE' };
    related(person, 'PERSON')[0].Attributes.PRIMARYEMAIL = {
      content: 'persona@demo.test',
    };
    related(person, 'PERSON')[0].rowstamp = '333333333';
    expect(maximoRawHash(person)).toBe(hash);

    const company = po5Raw();
    related(company, 'COMPANIES')[0].Attributes.ADDRESS1 = {
      content: 'Calle demo 1',
    };
    expect(maximoRawHash(company)).toBe(hash);
  });

  it('un cambio en STATUS, LINECOST, PO5 o en un campo proyectado de PERSON SÍ cambia el hash', () => {
    const hash = maximoRawHash(po5Raw());

    const status = po5Raw();
    status.Attributes.STATUS = { content: 'CLOSE' };
    expect(maximoRawHash(status)).not.toBe(hash);

    const lineCost = po5Raw();
    related(lineCost, 'POLINE')[0].Attributes.LINECOST = { content: 1 };
    expect(maximoRawHash(lineCost)).not.toBe(hash);

    const po5 = po5Raw();
    po5.Attributes.PO5 = { content: 'ERROR' };
    expect(maximoRawHash(po5)).not.toBe(hash);

    const displayName = po5Raw();
    related(displayName, 'PERSON')[0].Attributes.DISPLAYNAME = {
      content: 'Otra Persona Demo',
    };
    expect(maximoRawHash(displayName)).not.toBe(hash);
  });

  it('las dos formas del fixture prstatus (anidada y compacta) dan el mismo hash por PR', () => {
    const nested = contractPageFromFixture(
      'ab-contratos.legacy-nested.prstatus.SYNTHETIC.json',
    ).raw;
    const compact = contractPageFromFixture(
      'ab-contratos.legacy-compact.prstatus.SYNTHETIC.json',
    ).raw;
    expect(nested.map(maximoRawHash)).toEqual(compact.map(maximoRawHash));
  });
});

describe('K8 — re-mapeo sin "cambio" (AB_COMPRAS)', () => {
  it('mapper nuevo con el mismo rowstamp → remapped por mapper, sin last_changed_at; luego unchanged; un cambio solo en un hijo → remapped por hash; un rowstamp nuevo → updated', async () => {
    const { service, prisma, client, lines } = makeService({
      sync: { pageSize: 100 },
    });
    client.fetchPurchaseOrders.mockResolvedValueOnce(poPageOf(po5Raw()));
    const first = await service.syncPurchaseOrders('manual');
    expect(summaryOf(first)).toMatchObject({ inserted: 1, failed: 0 });
    const row = prisma.maximo_purchase_orders.rows[0];
    // K2/K6: columnas nuevas desde poMappedColumns
    expect(row.integration_status).toBe('PROCESADO');
    expect(row.subtotal).toBe(1755);
    expect(row.receipt_status).toBe('COMPLETE');

    // Fila escrita por el mapper anterior (sin las columnas de K2/K6)
    row.mapper_version = '2026.10.01-1';
    row.integration_status = null;
    row.subtotal = null;
    client.fetchPurchaseOrders.mockResolvedValueOnce(poPageOf(po5Raw()));
    const second = await service.syncPurchaseOrders('cron');
    expect(summaryOf(second)).toEqual({
      status: 'success',
      inserted: 0,
      updated: 0,
      remapped: 1,
      unchanged: 0,
      failed: 0,
    });
    expect(row.mapper_version).toBe(MAXIMO_MAPPER_VERSION);
    expect(row.integration_status).toBe('PROCESADO');
    expect(row.subtotal).toBe(1755);
    expect(row.last_changed_at).toBeUndefined();
    expect(row.last_sync_run_id).toBe(second.runId);
    expect(lines.join('\n')).toContain('remapped=1 (por mapper=1, por hash=0)');
    // el historial POSTATUS se reescribe, sin duplicar
    expect(
      prisma.maximo_po_status_history.rows.filter((h) => h.po_id === row.id),
    ).toHaveLength(3);
    const run = prisma.maximo_sync_runs.rows.find(
      (r) => r.id === second.runId,
    )!;
    expect(run.records_remapped).toBe(1);

    client.fetchPurchaseOrders.mockResolvedValueOnce(poPageOf(po5Raw()));
    const third = await service.syncPurchaseOrders('cron');
    expect(summaryOf(third)).toMatchObject({ remapped: 0, unchanged: 1 });

    // Recepción parcial en una línea: cambia POLINE, no el rowstamp de la OC
    const childOnly = po5Raw();
    related(childOnly, 'POLINE')[0].Attributes.RECEIVEDQTY = { content: 0.5 };
    client.fetchPurchaseOrders.mockResolvedValueOnce(poPageOf(childOnly));
    const fourth = await service.syncPurchaseOrders('cron');
    expect(summaryOf(fourth)).toMatchObject({ updated: 0, remapped: 1 });
    expect(row.last_changed_at).toBeUndefined();
    expect(lines.join('\n')).toContain(
      'remapped=1 (por mapper=0, por hash=1 ej.: PO104896|A3T|0)',
    );

    // Cambio real: Maximo mueve el rowstamp de la OC
    const realChange = structuredClone(childOnly);
    realChange.rowstamp = '990104897';
    realChange.Attributes.STATUS = { content: 'CLOSE' };
    client.fetchPurchaseOrders.mockResolvedValueOnce(poPageOf(realChange));
    const fifth = await service.syncPurchaseOrders('cron');
    expect(summaryOf(fifth)).toMatchObject({ updated: 1, remapped: 0 });
    expect(row.status).toBe('CLOSE');
    expect(row.last_changed_at).toBeDefined();
  });
});

describe('O (2026-10-26): CIISA agrega RFQSTATUS y EXCHANGERATE a las OC ya sincronizadas', () => {
  /** La OC de PO104896 con lo que CIISA agregó el 26-oct (mismo rowstamp). */
  function conRq(raw: NestedMbo = po5Raw()): NestedMbo {
    raw.Attributes.EXCHANGERATE = { content: 1.19 };
    raw.RelatedMbos = {
      ...raw.RelatedMbos,
      RFQSTATUS: [
        {
          rowstamp: '990300001',
          Attributes: {
            RFQNUM: { content: 'RQ990001' },
            CHANGEBY: { content: 'USR041' },
            RFQSTATUSSEQ: { content: 52164 },
          },
          RelatedMbos: {
            PERSON: [
              {
                rowstamp: '990300002',
                Attributes: {
                  PERSONID: { content: 'USR041' },
                  DISPLAYNAME: { content: 'Persona Demo 41' },
                },
              },
            ],
          },
        },
        {
          rowstamp: '990300003',
          Attributes: {
            RFQNUM: { content: 'RQ990001' },
            CHANGEBY: { content: 'USR042' },
            RFQSTATUSSEQ: { content: 52100 },
          },
        },
      ],
    };
    return raw;
  }

  it('el primer full con el mapper nuevo: un remapped por mapper con el raw nuevo, sin last_changed_at; después unchanged', async () => {
    const { service, prisma, client, lines } = makeService({
      sync: { pageSize: 100 },
    });
    // Sincronizada antes de que CIISA agregara los campos, con el mapper anterior
    client.fetchPurchaseOrders.mockResolvedValueOnce(poPageOf(po5Raw()));
    await service.syncPurchaseOrders('manual');
    const row = prisma.maximo_purchase_orders.rows[0];
    row.mapper_version = '2026.10.05-1';
    const hashAntes = row.raw_hash;

    client.fetchPurchaseOrders.mockResolvedValueOnce(poPageOf(conRq()));
    const second = await service.syncPurchaseOrders('cron');
    expect(summaryOf(second)).toEqual({
      status: 'success',
      inserted: 0,
      updated: 0,
      remapped: 1,
      unchanged: 0,
      failed: 0,
    });
    // la razón es el mapper (cambian los dos; el mapper manda)
    expect(lines.join('\n')).toContain('remapped=1 (por mapper=1, por hash=0)');
    expect(row.mapper_version).toBe(MAXIMO_MAPPER_VERSION);
    expect(row.raw_hash).not.toBe(hashAntes);
    expect(row.last_changed_at).toBeUndefined();
    // lo que leen las consultas (erp-views) ya está en el raw guardado
    const guardado = toPurchaseOrder(row.raw);
    expect(guardado.rfqBuyer?.changedBy).toBe('USR041');
    expect(guardado.exchangeRate).toBe(1.19);
    // las columnas mapeadas no cambian
    expect(row.created_by).toBe('USR024');
    expect(row.purchase_agent).toBe('USR024');

    client.fetchPurchaseOrders.mockResolvedValueOnce(poPageOf(conRq()));
    const third = await service.syncPurchaseOrders('cron');
    expect(summaryOf(third)).toMatchObject({
      updated: 0,
      remapped: 0,
      unchanged: 1,
    });
  });

  it('si CIISA los agrega cuando el mapper ya es el nuevo: remapped por hash, una vez', async () => {
    const { service, prisma, client, lines } = makeService({
      sync: { pageSize: 100 },
    });
    client.fetchPurchaseOrders.mockResolvedValueOnce(poPageOf(po5Raw()));
    await service.syncPurchaseOrders('manual');
    client.fetchPurchaseOrders.mockResolvedValueOnce(poPageOf(conRq()));
    const second = await service.syncPurchaseOrders('cron');
    expect(summaryOf(second)).toMatchObject({ updated: 0, remapped: 1 });
    expect(lines.join('\n')).toContain('por mapper=0, por hash=1');
    expect(
      prisma.maximo_purchase_orders.rows[0].last_changed_at,
    ).toBeUndefined();
  });

  it('el hash de RFQSTATUS: su orden, sus rowstamps y los campos de su PERSON fuera de la proyección no cuentan; el DISPLAYNAME sí', () => {
    const hash = maximoRawHash(conRq());

    const reordered = conRq();
    related(reordered, 'RFQSTATUS').reverse();
    related(reordered, 'RFQSTATUS')[0].rowstamp = '111111111';
    expect(maximoRawHash(reordered)).toBe(hash);

    const personStatus = conRq();
    related(
      related(personStatus, 'RFQSTATUS')[0],
      'PERSON',
    )[0].Attributes.STATUS = { content: 'INACTIVE' };
    expect(maximoRawHash(personStatus)).toBe(hash);

    const otroNombre = conRq();
    related(
      related(otroNombre, 'RFQSTATUS')[0],
      'PERSON',
    )[0].Attributes.DISPLAYNAME = { content: 'Persona Demo 43' };
    expect(maximoRawHash(otroNombre)).not.toBe(hash);

    const otroComprador = conRq();
    related(otroComprador, 'RFQSTATUS')[0].Attributes.CHANGEBY = {
      content: 'USR043',
    };
    expect(maximoRawHash(otroComprador)).not.toBe(hash);
  });
});

describe('K3/K8 — AB_CONTRATOS: historial de la PR y filas obsoletas', () => {
  it('K3: escribe los pr_* y UN historial por PR; una PR con dos revisiones queda con un historial completo', async () => {
    const { service, prisma, client } = makeService({
      sync: { pageSize: 100 },
    });
    client.fetchContracts.mockResolvedValueOnce(
      contractPageFromFixture(
        'ab-contratos.legacy-nested.prstatus.SYNTHETIC.json',
      ),
    );
    const first = await service.syncContracts('manual');
    if (isSyncSkipped(first)) throw new Error('no debió omitirse');
    // 7 PR; PR990006 con dos revisiones del contrato 9906
    expect(summaryOf(first)).toMatchObject({ inserted: 8, failed: 0 });

    const pr6 = prisma.maximo_contracts.rows.filter(
      (r) => r.prnum === 'PR990006',
    );
    expect(pr6.map((r) => r.revisionnum).sort()).toEqual([0, 1]);
    for (const row of pr6) {
      expect(row.pr_status).toBe('CLOSE');
      expect(row.pr_issue_date).toEqual(new Date('2026-06-10T14:00:00+00:00'));
      expect(row.pr_approved_at).toEqual(new Date('2026-06-11T09:00:00+00:00'));
      expect(row.pr_approved_by).toBe('USR023');
      expect(row.pr_closed_at).toEqual(new Date('2026-06-15T12:00:00+00:00'));
      expect(row.superseded_at).toBeNull();
    }
    // Estado final: un solo historial, completo y en orden
    const history6 = prisma.maximo_pr_status_history.rows
      .filter((h) => h.prnum === 'PR990006')
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    expect(history6.map((h) => [h.seq, h.status, h.changed_by])).toEqual([
      [0, 'WAPPR', 'USR030'],
      [1, 'APPR', 'USR023'],
      [2, 'CLOSE', 'USR024'],
    ]);
    expect(history6[0].change_date).toEqual(
      new Date('2026-06-10T14:00:00+00:00'),
    );

    // CAN con MEMO y quién canceló
    const pr3 = prisma.maximo_contracts.rows.find(
      (r) => r.prnum === 'PR990003',
    )!;
    expect(pr3.pr_status).toBe('CAN');
    expect(pr3.pr_cancelled_at).toEqual(new Date('2026-08-28T16:40:00+00:00'));
    expect(pr3.pr_cancelled_by).toBe('USR024');
    const can = prisma.maximo_pr_status_history.rows.find(
      (h) => h.prnum === 'PR990003' && h.status === 'CAN',
    )!;
    expect(can.memo).toEqual(expect.any(String));

    // Sin duplicados: (prnum, seq) único, como uq_maximo_pr_status_history
    const keys = prisma.maximo_pr_status_history.rows.map(
      (h) => `${String(h.prnum)}|${String(h.seq)}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    const historyCount = keys.length;

    // La forma compacta del mismo registro: todo unchanged, historial igual
    client.fetchContracts.mockResolvedValueOnce(
      contractPageFromFixture(
        'ab-contratos.legacy-compact.prstatus.SYNTHETIC.json',
      ),
    );
    const second = await service.syncContracts('cron');
    if (isSyncSkipped(second)) throw new Error('no debió omitirse');
    expect(summaryOf(second)).toMatchObject({
      inserted: 0,
      updated: 0,
      remapped: 0,
      unchanged: 8,
    });
    expect(prisma.maximo_pr_status_history.rows).toHaveLength(historyCount);
  });

  it('K8: contrato con mapper nuevo y los mismos rowstamps → remapped; un STATUS nuevo de la PR (otro pr_rowstamp) → updated', async () => {
    const { service, prisma, client } = makeService({
      sync: { pageSize: 100 },
    });
    client.fetchContracts.mockResolvedValueOnce(
      contractPageOf(prRecord('PR-K8R', { revisions: [0] })),
    );
    await service.syncContracts('manual');
    const [row] = prisma.maximo_contracts.rows;
    row.mapper_version = '2026.10.01-1';

    client.fetchContracts.mockResolvedValueOnce(
      contractPageOf(prRecord('PR-K8R', { revisions: [0] })),
    );
    const second = await service.syncContracts('cron');
    if (isSyncSkipped(second)) throw new Error('no debió omitirse');
    expect(summaryOf(second)).toMatchObject({ updated: 0, remapped: 1 });
    expect(row.last_changed_at).toBeUndefined();
    expect(row.last_sync_run_id).toBe(second.runId);

    // La PR cambia (mismo contract_rowstamp, otro rowstamp de la raíz)
    const closed = prRecord('PR-K8R', {
      revisions: [0],
      rowstamp: 'PR-K8R-ROOT-2',
    });
    closed.STATUS = 'CLOSE';
    client.fetchContracts.mockResolvedValueOnce(contractPageOf(closed));
    const third = await service.syncContracts('cron');
    if (isSyncSkipped(third)) throw new Error('no debió omitirse');
    expect(summaryOf(third)).toMatchObject({ updated: 1, remapped: 0 });
    expect(row.pr_status).toBe('CLOSE');
    expect(row.last_changed_at).toBeDefined();
  });

  it('K8: un contract_rowstamp nuevo con la misma raíz y el mismo hash → updated; sin contrato (los dos nulos) y la misma raíz → unchanged', async () => {
    const { service, prisma, client } = makeService({
      sync: { pageSize: 100 },
    });
    const withContract = () => prRecord('PR-K8C', { revisions: [0] });
    const noContract = () => prRecord('PR-K8S');
    client.fetchContracts.mockResolvedValueOnce(
      contractPageOf(withContract(), noContract()),
    );
    await service.syncContracts('manual');
    const row = prisma.maximo_contracts.rows.find((r) => r.prnum === 'PR-K8C')!;
    const bare = prisma.maximo_contracts.rows.find(
      (r) => r.prnum === 'PR-K8S',
    )!;
    expect(row.contract_rowstamp).toBe('PR-K8C-PV-0');
    expect(bare.contract_rowstamp).toBeNull();

    // Solo se mueve el rowstamp del PURCHVIEW: la raíz y el hash (que no
    // lleva ROWSTAMP) quedan iguales, así que decide contract_rowstamp
    const moved = withContract();
    (moved.PURCHVIEW as Array<Record<string, unknown>>)[0].rowstamp =
      'PR-K8C-PV-0-B';
    expect(maximoRawHash(moved)).toBe(row.raw_hash);
    client.fetchContracts.mockResolvedValueOnce(
      contractPageOf(moved, noContract()),
    );
    const second = await service.syncContracts('cron');
    if (isSyncSkipped(second)) throw new Error('no debió omitirse');
    expect(summaryOf(second)).toMatchObject({
      updated: 1,
      remapped: 0,
      unchanged: 1,
      failed: 0,
    });
    expect(row.contract_rowstamp).toBe('PR-K8C-PV-0-B');
    expect(row.last_changed_at).toBeDefined();
    expect(bare.last_changed_at).toBeUndefined();
  });

  it.each([
    ['sin rowstamp en ninguna de las dos capturas', null],
    ['con rowstamp en la captura nueva', 'PR-K8N-ROOT-1'],
  ])(
    'K8: una fila con pr_rowstamp null nunca es "mismo rowstamp" (%s) → updated aunque el hash y el contrato sean iguales',
    async (_caso, nextRowstamp) => {
      const { service, prisma, client } = makeService({
        sync: { pageSize: 100 },
      });
      const record = (rowstamp: string | null) => {
        const pr = prRecord('PR-K8N', { revisions: [0] });
        if (rowstamp === null) delete pr.rowstamp;
        else pr.rowstamp = rowstamp;
        return pr;
      };
      client.fetchContracts.mockResolvedValueOnce(contractPageOf(record(null)));
      await service.syncContracts('manual');
      const [row] = prisma.maximo_contracts.rows;
      expect(row.pr_rowstamp).toBeNull();
      expect(row.contract_rowstamp).toBe('PR-K8N-PV-0');

      const next = record(nextRowstamp);
      expect(maximoRawHash(next)).toBe(row.raw_hash);
      client.fetchContracts.mockResolvedValueOnce(contractPageOf(next));
      const second = await service.syncContracts('cron');
      if (isSyncSkipped(second)) throw new Error('no debió omitirse');
      expect(summaryOf(second)).toMatchObject({
        updated: 1,
        remapped: 0,
        unchanged: 0,
        failed: 0,
      });
      expect(row.pr_rowstamp).toBe(nextRowstamp);
      expect(row.last_changed_at).toBeDefined();
    },
  );

  it('K8: una PR que pasa de sin contrato a con contrato deja la fila vieja superseded (fuera del conteo vigente); si la llave reaparece igual, se limpia', async () => {
    const { service, prisma, client, lines } = makeService({
      sync: { pageSize: 100 },
    });
    const vigentes = () =>
      prisma.maximo_contracts.count({
        where: { prnum: 'PR-K8', superseded_at: null },
      });

    client.fetchContracts.mockResolvedValueOnce(
      contractPageOf(prRecord('PR-K8')),
    );
    await service.syncContracts('manual');
    const old = prisma.maximo_contracts.rows.find(
      (r) => r.prnum === 'PR-K8' && r.contractnum === null,
    )!;
    expect(old.superseded_at).toBeNull();

    const withContract = () =>
      prRecord('PR-K8', { rowstamp: 'PR-K8-ROOT-2', revisions: [0] });
    client.fetchContracts.mockResolvedValueOnce(contractPageOf(withContract()));
    const second = await service.syncContracts('cron');
    if (isSyncSkipped(second)) throw new Error('no debió omitirse');
    expect(summaryOf(second)).toMatchObject({ inserted: 1, failed: 0 });
    const current = prisma.maximo_contracts.rows.find(
      (r) => r.prnum === 'PR-K8' && r.contractnum === 'C1',
    )!;
    expect(old.superseded_at).toEqual(expect.any(Object));
    expect(current.superseded_at).toBeNull();
    expect(await vigentes()).toBe(1);
    expect(lines.join('\n')).toContain('superseded=1');

    // La siguiente corrida no reescribe la fecha de la obsoleta (fecha fija
    // para no depender del reloj)
    const supersededAt = new Date('2026-10-01T00:00:00Z');
    old.superseded_at = supersededAt;
    client.fetchContracts.mockResolvedValueOnce(contractPageOf(withContract()));
    const third = await service.syncContracts('cron');
    if (isSyncSkipped(third)) throw new Error('no debió omitirse');
    expect(summaryOf(third)).toMatchObject({ unchanged: 1, failed: 0 });
    expect(old.superseded_at).toBe(supersededAt);
    expect(prisma.maximo_contracts.updateMany).toHaveBeenCalledTimes(1);

    // La llave vieja reaparece con el mismo raw → unchanged y se limpia; la
    // del contrato, que ya no viene, queda obsoleta
    client.fetchContracts.mockResolvedValueOnce(
      contractPageOf(prRecord('PR-K8')),
    );
    const fourth = await service.syncContracts('cron');
    if (isSyncSkipped(fourth)) throw new Error('no debió omitirse');
    expect(summaryOf(fourth)).toMatchObject({ unchanged: 1, failed: 0 });
    expect(old.superseded_at).toBeNull();
    expect(current.superseded_at).toEqual(expect.any(Object));
    expect(await vigentes()).toBe(1);
  });

  it('K8: un registro con prnum null (raíz PURCHVIEW) no marca nada', async () => {
    const { service, prisma, staging, client } = makeService({
      sync: { pageSize: 100 },
    });
    // Contrato sin PR de OTRO registro: con `where: { prnum: null }` se marcaría
    await prisma.maximo_contracts.create({
      data: {
        prnum: null,
        contractnum: '7777',
        revisionnum: 0,
        superseded_at: null,
      },
    });
    const supersede = jest.spyOn(staging, 'supersedeMissingRevisions');
    client.fetchContracts.mockResolvedValueOnce(
      contractPageFromFixture(
        'ab-contratos.legacy-compact.purchview-root.v1.json',
      ),
    );
    const result = await service.syncContracts('manual');
    if (isSyncSkipped(result)) throw new Error('no debió omitirse');
    expect(result.recordsFailed).toBe(0);
    expect(supersede).toHaveBeenCalledWith(null, expect.any(Array));
    expect(prisma.maximo_contracts.updateMany).not.toHaveBeenCalled();
    expect(
      prisma.maximo_contracts.rows.every((r) => r.superseded_at === null),
    ).toBe(true);
    await expect(staging.supersedeMissingRevisions('', [])).resolves.toBe(0);
  });

  it('K8: con un upsert fallido en el registro no se marca nada', async () => {
    const { service, prisma, staging, client } = makeService({
      sync: { pageSize: 100 },
    });
    client.fetchContracts.mockResolvedValueOnce(
      contractPageOf(prRecord('PR-K8F')),
    );
    await service.syncContracts('manual');

    const original = staging.upsertContract.bind(staging);
    jest
      .spyOn(staging, 'upsertContract')
      .mockImplementation((dto, raw, runId) =>
        dto.revisionNum === 1
          ? Promise.reject(new Error('fallo simulado'))
          : original(dto, raw, runId),
      );
    const supersede = jest.spyOn(staging, 'supersedeMissingRevisions');
    client.fetchContracts.mockResolvedValueOnce(
      contractPageOf(
        prRecord('PR-K8F', { rowstamp: 'PR-K8F-ROOT-2', revisions: [0, 1] }),
      ),
    );
    const result = await service.syncContracts('cron');
    if (isSyncSkipped(result)) throw new Error('no debió omitirse');
    expect(summaryOf(result)).toMatchObject({
      status: 'partial',
      inserted: 1,
      failed: 1,
    });
    expect(supersede).not.toHaveBeenCalled();
    expect(
      prisma.maximo_contracts.rows.every((r) => r.superseded_at === null),
    ).toBe(true);
  });

  it('K8: una excepción en supersedeMissingRevisions cuenta un fallo y la página sigue', async () => {
    const { service, prisma, staging, client } = makeService({
      sync: { pageSize: 100 },
    });
    jest
      .spyOn(staging, 'supersedeMissingRevisions')
      .mockRejectedValueOnce(new Error('BD caída'));
    client.fetchContracts.mockResolvedValueOnce(
      contractPageOf(prRecord('PR-K8A'), prRecord('PR-K8B')),
    );
    const result = await service.syncContracts('manual');
    if (isSyncSkipped(result)) throw new Error('no debió omitirse');
    expect(summaryOf(result)).toEqual({
      status: 'partial',
      inserted: 2,
      updated: 0,
      remapped: 0,
      unchanged: 0,
      failed: 1,
    });
    expect(result.pagesOk).toBe(1);
    expect(result.pagesFailed).toBe(0);
    expect(result.errorSummary).toContain('obsoletas de PR-K8A: BD caída');
    expect(prisma.maximo_contracts.rows.map((r) => r.prnum)).toEqual([
      'PR-K8A',
      'PR-K8B',
    ]);
  });
});
