import { SapSyncService } from './sap-sync.service';
import { SapStagingService } from './sap-staging.service';
import { SapClient } from '../sap.client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SapSyncDisabledError,
  SapSyncInProgressError,
} from './sap-sync.errors';

/**
 * Fase INT-4. Motor de sync con cliente/staging/Prisma mockeados — sin red
 * ni BD. Cubre: gate por flag, mutex por target, resolución de modo
 * (full/incremental con margen de 2 días), paginación $skip con /$count,
 * tolerancia a fallo por página y el estado final de la corrida.
 */

const PAGE_SIZE = 2;

function makeHarness(
  opts: {
    enabled?: boolean;
    poDocs?: number;
    maxUpdateInStaging?: Date | null;
    failPageAtSkip?: number[];
    /** Default true: existe un full exitoso previo (base del incremental). */
    hasSuccessfulFull?: boolean;
    /** Última corrida no-running del target (para el retroceso del corte). */
    lastRun?: { status: string; since_filter: Date | null } | null;
  } = {},
) {
  const enabled = opts.enabled ?? true;
  const totalDocs = opts.poDocs ?? 5;
  const failAt = new Set(opts.failPageAtSkip ?? []);
  const runs: Array<Record<string, unknown> & { id: string }> = [];
  let runSeq = 0;
  const upserts: number[] = [];
  const fetchCalls: Array<{ top: number; skip: number; updatedSince?: Date }> =
    [];

  const prisma = {
    sap_sync_runs: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `run-${++runSeq}`, ...data };
        runs.push(row);
        return Promise.resolve({ id: row.id });
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = runs.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        if (where.mode === 'full') {
          return Promise.resolve(
            (opts.hasSuccessfulFull ?? true) ? { id: 'full-ok' } : null,
          );
        }
        return Promise.resolve(opts.lastRun ?? null);
      }),
    },
    sap_purchase_orders: {
      aggregate: jest.fn(() =>
        Promise.resolve({
          _max: { update_date_source: opts.maxUpdateInStaging ?? null },
        }),
      ),
    },
    sap_purchase_requests: {
      aggregate: jest.fn(() =>
        Promise.resolve({ _max: { update_date_source: null } }),
      ),
    },
  };

  const client = {
    countPurchaseOrders: jest.fn(() => Promise.resolve(totalDocs)),
    countPurchaseRequests: jest.fn(() => Promise.resolve(0)),
    fetchPurchaseOrders: jest.fn(
      (params: { top: number; skip: number; updatedSince?: Date }) => {
        fetchCalls.push(params);
        if (failAt.has(params.skip)) {
          return Promise.reject(
            new Error(`fallo simulado skip=${params.skip}`),
          );
        }
        const remaining = Math.max(0, totalDocs - params.skip);
        const got = Math.min(params.top, remaining);
        return Promise.resolve({
          records: Array.from({ length: got }, (_, i) => ({
            docEntry: params.skip + i + 1,
          })),
          raw: Array.from({ length: got }, (_, i) => ({
            DocEntry: params.skip + i + 1,
          })),
          http: { status: 200, durationMs: 1, attempts: 1 },
        });
      },
    ),
    fetchPurchaseRequests: jest.fn(() =>
      Promise.resolve({
        records: [],
        raw: [],
        http: { status: 200, durationMs: 1, attempts: 1 },
      }),
    ),
  };

  const staging = {
    upsertPurchaseOrder: jest.fn((dto: { docEntry: number }) => {
      upserts.push(dto.docEntry);
      return Promise.resolve('inserted' as const);
    }),
    upsertPurchaseRequest: jest.fn(() => Promise.resolve('inserted' as const)),
  };

  const service = new SapSyncService(
    prisma as unknown as PrismaService,
    client as unknown as SapClient,
    staging as unknown as SapStagingService,
    { enabled, intervalMinutes: 60, pageSize: PAGE_SIZE },
    { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  );

  return { service, prisma, client, staging, runs, upserts, fetchCalls };
}

describe('SapSyncService — gates', () => {
  it('SAP_SYNC_ENABLED=false → SapSyncDisabledError sin tocar red ni BD', async () => {
    const h = makeHarness({ enabled: false });
    await expect(h.service.syncPurchaseOrders('manual')).rejects.toThrow(
      SapSyncDisabledError,
    );
    expect(h.client.fetchPurchaseOrders).not.toHaveBeenCalled();
    expect(h.prisma.sap_sync_runs.create).not.toHaveBeenCalled();
  });

  it('mutex por target: corrida solapada → SapSyncInProgressError', async () => {
    const h = makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.client.fetchPurchaseOrders.mockImplementationOnce(async () => {
      await gate;
      return {
        records: [],
        raw: [],
        http: { status: 200, durationMs: 1, attempts: 1 },
      };
    });
    const first = h.service.syncPurchaseOrders('manual');
    await Promise.resolve(); // deja que la primera tome el mutex
    await expect(h.service.syncPurchaseOrders('manual')).rejects.toThrow(
      SapSyncInProgressError,
    );
    release();
    await first;
    // liberado el mutex, una nueva corrida entra sin problema
    await expect(h.service.syncPurchaseOrders('manual')).resolves.toMatchObject(
      { target: 'purchase_orders' },
    );
  });
});

describe('SapSyncService — modo full/incremental', () => {
  it('staging vacío → full aunque se pida incremental (no hay corte)', async () => {
    const h = makeHarness({ maxUpdateInStaging: null });
    const summary = await h.service.syncPurchaseOrders(
      'manual',
      null,
      'incremental',
    );
    expect(summary.mode).toBe('full');
    expect(summary.sinceFilter).toBeNull();
    expect(h.fetchCalls[0].updatedSince).toBeUndefined();
  });

  it('con datos → incremental con corte = max(update_date_source) − 2 días', async () => {
    const maxUpdate = new Date(Date.UTC(2026, 8, 15));
    const h = makeHarness({ maxUpdateInStaging: maxUpdate });
    const summary = await h.service.syncPurchaseOrders('cron');
    expect(summary.mode).toBe('incremental');
    expect(summary.sinceFilter).toEqual(new Date(Date.UTC(2026, 8, 13)));
    expect(h.fetchCalls[0].updatedSince).toEqual(
      new Date(Date.UTC(2026, 8, 13)),
    );
    // el /$count usa el MISMO corte
    expect(h.client.countPurchaseOrders).toHaveBeenCalledWith(
      new Date(Date.UTC(2026, 8, 13)),
    );
  });

  it('mode=full explícito ignora el corte aunque haya datos', async () => {
    const h = makeHarness({ maxUpdateInStaging: new Date() });
    const summary = await h.service.syncPurchaseOrders('manual', null, 'full');
    expect(summary.mode).toBe('full');
    expect(summary.sinceFilter).toBeNull();
  });

  it('sin un full EXITOSO previo → full aunque el staging tenga datos (full interrumpido no deja hueco)', async () => {
    const h = makeHarness({
      maxUpdateInStaging: new Date(),
      hasSuccessfulFull: false,
    });
    const summary = await h.service.syncPurchaseOrders('cron');
    expect(summary.mode).toBe('full');
    expect(summary.sinceFilter).toBeNull();
  });

  it('última corrida partial → el corte retrocede a su since_filter (re-cubre páginas fallidas)', async () => {
    const h = makeHarness({
      maxUpdateInStaging: new Date(Date.UTC(2026, 8, 15)),
      lastRun: {
        status: 'partial',
        since_filter: new Date(Date.UTC(2026, 8, 1)),
      },
    });
    const summary = await h.service.syncPurchaseOrders('cron');
    expect(summary.mode).toBe('incremental');
    // min(2026-09-13 calculado, 2026-09-01 de la corrida coja) = 09-01
    expect(summary.sinceFilter).toEqual(new Date(Date.UTC(2026, 8, 1)));
  });
});

describe('SapSyncService — página corta con tope del servidor', () => {
  it('si el SL acota $top (got < pageSize) pero falta total, la corrida SIGUE hasta la página vacía', async () => {
    // pageSize efectivo del server = 1 (devuelve 1 aunque se pidan 2)
    const h = makeHarness({ poDocs: 3 });
    h.client.fetchPurchaseOrders.mockImplementation(
      (params: { top: number; skip: number }) => {
        h.fetchCalls.push(params);
        const remaining = Math.max(0, 3 - params.skip);
        const got = Math.min(1, remaining); // el server ignora top=2
        return Promise.resolve({
          records: Array.from({ length: got }, (_, i) => ({
            docEntry: params.skip + i + 1,
          })),
          raw: Array.from({ length: got }, (_, i) => ({
            DocEntry: params.skip + i + 1,
          })),
          http: { status: 200, durationMs: 1, attempts: 1 },
        });
      },
    );
    h.client.countPurchaseOrders.mockResolvedValue(3);
    const summary = await h.service.syncPurchaseOrders('manual');
    expect(summary.status).toBe('success');
    expect(summary.recordsFetched).toBe(3); // sin truncar en la primera página corta
    expect(h.fetchCalls.map((c) => c.skip)).toEqual([0, 1, 2]);
  });
});

describe('SapSyncService — paginación y resultado', () => {
  it('recorre todas las páginas por $skip y termina en la página corta', async () => {
    const h = makeHarness({ poDocs: 5 }); // pageSize 2 → páginas 2+2+1
    const summary = await h.service.syncPurchaseOrders('manual');
    expect(summary.status).toBe('success');
    expect(summary.recordsFetched).toBe(5);
    expect(summary.recordsInserted).toBe(5);
    expect(summary.pagesOk).toBe(3);
    expect(summary.pagesTotal).toBe(3); // ceil(5/2) del /$count
    expect(h.upserts).toEqual([1, 2, 3, 4, 5]);
    expect(h.fetchCalls.map((c) => c.skip)).toEqual([0, 2, 4]);
    // la corrida quedó persistida como success
    expect(h.runs[0].status).toBe('success');
    expect(h.runs[0].finished_at).toBeInstanceOf(Date);
  });

  it('una página falla → la corrida continúa y termina partial con el error registrado', async () => {
    const h = makeHarness({ poDocs: 6, failPageAtSkip: [2] });
    const summary = await h.service.syncPurchaseOrders('manual');
    expect(summary.status).toBe('partial');
    expect(summary.pagesFailed).toBe(1);
    expect(summary.recordsFetched).toBe(4); // páginas 0 y 4
    expect(summary.errorSummary).toContain('skip=2');
  });

  it('todas las páginas fallan → failed', async () => {
    const h = makeHarness({ poDocs: 6, failPageAtSkip: [0, 2, 4] });
    const summary = await h.service.syncPurchaseOrders('manual');
    expect(summary.status).toBe('failed');
    expect(summary.pagesOk).toBe(0);
  });

  it('startTarget: devuelve run_id de inmediato y procesa en background', async () => {
    const h = makeHarness({ poDocs: 2 });
    const runId = await h.service.startTarget(
      'purchase_orders',
      'manual',
      'user-1',
    );
    expect(runId).toBe('run-1');
    // dejar drenar el background
    await new Promise((r) => setTimeout(r, 0));
    expect(h.runs[0].status).toBe('success');
    expect(h.runs[0].triggered_by_user_id).toBe('user-1');
  });
});
