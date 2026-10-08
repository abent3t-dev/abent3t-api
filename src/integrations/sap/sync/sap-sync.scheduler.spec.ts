import { SchedulerRegistry } from '@nestjs/schedule';
import {
  FULL_DAILY_BUSY_MAX_ATTEMPTS,
  FULL_DAILY_BUSY_RETRY_MS,
  FULL_DAILY_FAILURE_MAX_RETRIES,
  FULL_DAILY_FAILURE_RETRY_MS,
  SAP_SYNC_FULL_DAILY_NAME,
  SAP_SYNC_TIMEOUT_NAME,
  SapSyncScheduler,
} from './sap-sync.scheduler';
import { SapSyncService } from './sap-sync.service';
import type { SapSyncConfig } from './sap-sync.config';
import { SapSyncInProgressError } from './sap-sync.errors';
import { SAP_FULL_DAILY_TARGETS } from './sap-sync.types';
import type { SapSyncRunStatus, SapSyncTarget } from './sap-sync.types';
import { SAP_MAPPER_VERSION } from '../sap.mapper';
import {
  clearRegistry,
  makeSapSyncHarness,
  sapDoc,
  silentLogger,
} from './testing/sap-sync.testkit';

/**
 * L1 (2026-10-08). Scheduler del sync de SAP: el incremental horario sigue
 * igual y se agrega un full diario de OC, solicitudes y proveedores a
 * SAP_SYNC_FULL_DAILY_AT (hora de México), con reintento si falla y
 * recuperación al arrancar. Sin red: service simulado o, en las pruebas de
 * punta a punta, el motor real con Prisma en memoria y el Service Layer
 * simulado (testkit).
 */

/** 02:59:50 en Ciudad de México (UTC−6 todo el año desde 2022). */
const BEFORE_3AM_MX = new Date('2026-10-08T08:59:50Z');
const HOUR_MS = 60 * 60_000;

/** Resumen mínimo de una corrida (lo que lee el scheduler). */
const summary = (
  status: Exclude<SapSyncRunStatus, 'running'>,
  extra: { pagesFailed?: number; recordsFailed?: number } = {},
) => ({
  runId: `run-${status}`,
  status,
  pagesFailed: status === 'failed' ? 3 : 0,
  recordsFailed: 0,
  ...extra,
});

function makeScheduler(
  opts: {
    enabled?: boolean;
    fullDailyAt?: string | null;
    /** Último full exitoso por target; sin dato = recién hecho. */
    lastFull?: Partial<Record<SapSyncTarget, Date | null>>;
  } = {},
) {
  const lines: string[] = [];
  const ok = () => jest.fn().mockResolvedValue(summary('success'));
  const syncService = {
    syncPurchaseOrders: ok(),
    syncPurchaseRequests: ok(),
    syncBusinessPartners: ok(),
    syncApprovalRequests: ok(),
    lastFullSuccessAt: jest.fn((target: SapSyncTarget) =>
      Promise.resolve(
        opts.lastFull && target in opts.lastFull
          ? (opts.lastFull[target] ?? null)
          : new Date(),
      ),
    ),
  };
  const registry = new SchedulerRegistry();
  const config: SapSyncConfig = {
    enabled: opts.enabled ?? true,
    intervalMinutes: 60,
    pageSize: 20,
    fullDailyAt: opts.fullDailyAt === undefined ? '03:00' : opts.fullDailyAt,
  };
  const scheduler = new SapSyncScheduler(
    syncService as unknown as SapSyncService,
    registry,
    config,
    silentLogger(lines),
  );
  return { scheduler, syncService, registry, lines };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('SapSyncScheduler — gate SAP_SYNC_ENABLED', () => {
  it('con SAP_SYNC_ENABLED=false no registra nada (ni full diario ni recuperación) y nada llama al service', async () => {
    const { scheduler, syncService, registry, lines } = makeScheduler({
      enabled: false,
      lastFull: { purchase_orders: null },
    });
    scheduler.onApplicationBootstrap();
    expect(registry.getCronJobs().size).toBe(0);
    expect(registry.getTimeouts()).toEqual([]);
    expect(lines.join('\n')).toContain('cron NO registrado');

    await scheduler.tick();
    await scheduler.fullDailyTick();
    await scheduler.recoverFullDaily();
    for (const fn of Object.values(syncService)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe('SapSyncScheduler — full diario (L1)', () => {
  it('se programa a SAP_SYNC_FULL_DAILY_AT en hora de México y dispara OC, solicitudes y proveedores en modo full', async () => {
    jest.useFakeTimers({ now: BEFORE_3AM_MX });
    const { scheduler, syncService, registry, lines } = makeScheduler();
    try {
      scheduler.onApplicationBootstrap();
      const job = registry.getCronJob(SAP_SYNC_FULL_DAILY_NAME);
      expect(job.cronTime.source).toBe('0 3 * * *');
      expect(job.cronTime.timeZone).toBe('America/Mexico_City');
      // 03:00 en México = 09:00 UTC
      expect(job.nextDate().toJSDate().toISOString()).toBe(
        '2026-10-08T09:00:00.000Z',
      );
      expect(lines.join('\n')).toContain(
        'programado a las 03:00 (America/Mexico_City)',
      );
      // el incremental sigue registrado como antes
      expect(registry.doesExist('timeout', SAP_SYNC_TIMEOUT_NAME)).toBe(true);

      await jest.advanceTimersByTimeAsync(9_000); // 02:59:59
      expect(syncService.syncPurchaseOrders).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(2_000); // 03:00:01
      const full = ['cron', null, 'full'];
      expect(syncService.syncPurchaseOrders.mock.calls).toEqual([full]);
      expect(syncService.syncPurchaseRequests.mock.calls).toEqual([full]);
      expect(syncService.syncBusinessPartners.mock.calls).toEqual([full]);
      const order = [
        syncService.syncPurchaseOrders,
        syncService.syncPurchaseRequests,
        syncService.syncBusinessPartners,
      ].map((fn) => fn.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // la cola de autorización ya es full en cada tick horario
      expect(SAP_FULL_DAILY_TARGETS).toEqual([
        'purchase_orders',
        'purchase_requests',
        'business_partners',
      ]);
      expect(syncService.syncApprovalRequests).not.toHaveBeenCalled();
      // y queda armado para el día siguiente
      expect(job.nextDate().toJSDate().toISOString()).toBe(
        '2026-10-09T09:00:00.000Z',
      );
    } finally {
      clearRegistry(registry);
    }
  });

  it('respeta otra hora (02:30 → mañana, porque ya pasó) y con off no registra el full pero sí el incremental', () => {
    jest.useFakeTimers({ now: BEFORE_3AM_MX });
    const other = makeScheduler({ fullDailyAt: '02:30' });
    const off = makeScheduler({ fullDailyAt: null });
    try {
      other.scheduler.onApplicationBootstrap();
      const job = other.registry.getCronJob(SAP_SYNC_FULL_DAILY_NAME);
      expect(job.cronTime.source).toBe('30 2 * * *');
      expect(job.nextDate().toJSDate().toISOString()).toBe(
        '2026-10-09T08:30:00.000Z',
      );

      off.scheduler.onApplicationBootstrap();
      expect(off.registry.doesExist('cron', SAP_SYNC_FULL_DAILY_NAME)).toBe(
        false,
      );
      expect(off.registry.doesExist('timeout', SAP_SYNC_TIMEOUT_NAME)).toBe(
        true,
      );
      expect(off.lines.join('\n')).toContain(
        'Full diario de SAP apagado (SAP_SYNC_FULL_DAILY_AT=off)',
      );
    } finally {
      clearRegistry(other.registry);
      clearRegistry(off.registry);
    }
  });

  it('target ocupado (409 del service): espera, reintenta y no pasa a solicitudes hasta terminar las OC', async () => {
    jest.useFakeTimers({ now: BEFORE_3AM_MX });
    const { scheduler, syncService, lines } = makeScheduler();
    syncService.syncPurchaseOrders.mockRejectedValueOnce(
      new SapSyncInProgressError('purchase_orders'),
    );

    const run = scheduler.fullDailyTick();
    await jest.advanceTimersByTimeAsync(0);
    expect(syncService.syncPurchaseOrders).toHaveBeenCalledTimes(1);
    expect(syncService.syncPurchaseRequests).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain(
      `full diario: corrida de purchase_orders en curso — reintento en 60 s (1/${FULL_DAILY_BUSY_MAX_ATTEMPTS})`,
    );

    await jest.advanceTimersByTimeAsync(FULL_DAILY_BUSY_RETRY_MS);
    await run;
    expect(syncService.syncPurchaseOrders).toHaveBeenCalledTimes(2);
    expect(syncService.syncPurchaseOrders).toHaveBeenLastCalledWith(
      'cron',
      null,
      'full',
    );
    expect(syncService.syncPurchaseRequests).toHaveBeenCalledTimes(1);
  });

  it('si el target sigue ocupado tras FULL_DAILY_BUSY_MAX_ATTEMPTS lo omite hasta mañana y sigue con los demás', async () => {
    jest.useFakeTimers({ now: BEFORE_3AM_MX });
    const { scheduler, syncService, lines } = makeScheduler();
    syncService.syncPurchaseOrders.mockRejectedValue(
      new SapSyncInProgressError('purchase_orders'),
    );

    const run = scheduler.fullDailyTick();
    await jest.advanceTimersByTimeAsync(
      FULL_DAILY_BUSY_RETRY_MS * FULL_DAILY_BUSY_MAX_ATTEMPTS,
    );
    await run;
    expect(syncService.syncPurchaseOrders).toHaveBeenCalledTimes(
      FULL_DAILY_BUSY_MAX_ATTEMPTS,
    );
    expect(lines.join('\n')).toContain(
      `purchase_orders siguió ocupado tras ${FULL_DAILY_BUSY_MAX_ATTEMPTS} intentos — se omite hasta mañana`,
    );
    expect(syncService.syncPurchaseRequests).toHaveBeenCalledWith(
      'cron',
      null,
      'full',
    );
    expect(syncService.syncBusinessPartners).toHaveBeenCalledTimes(1);
  });

  it('corrida failed (el SL no respondió): reintenta a los 15 min y no pasa a solicitudes hasta que las OC salen bien', async () => {
    jest.useFakeTimers({ now: BEFORE_3AM_MX });
    const { scheduler, syncService, lines } = makeScheduler();
    syncService.syncPurchaseOrders.mockResolvedValueOnce(summary('failed'));

    const run = scheduler.fullDailyTick();
    await jest.advanceTimersByTimeAsync(0);
    expect(syncService.syncPurchaseOrders).toHaveBeenCalledTimes(1);
    expect(syncService.syncPurchaseRequests).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain(
      `full diario: purchase_orders falló (corrida run-failed terminó failed (3 página(s) fallida(s))) — reintento en 15 min (1/${FULL_DAILY_FAILURE_MAX_RETRIES})`,
    );

    await jest.advanceTimersByTimeAsync(FULL_DAILY_FAILURE_RETRY_MS - 1_000);
    expect(syncService.syncPurchaseOrders).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    await run;
    expect(syncService.syncPurchaseOrders).toHaveBeenCalledTimes(2);
    expect(syncService.syncPurchaseRequests).toHaveBeenCalledTimes(1);
    expect(syncService.syncBusinessPartners).toHaveBeenCalledTimes(1);
  });

  it('también reintenta un error que no es de ocupado (p. ej. el login del SL) y un partial con páginas fallidas', async () => {
    jest.useFakeTimers({ now: BEFORE_3AM_MX });
    const { scheduler, syncService, lines } = makeScheduler();
    syncService.syncPurchaseOrders.mockRejectedValueOnce(
      new Error('login del Service Layer: 401'),
    );
    // el SL se cayó a media corrida: partial con páginas fallidas
    syncService.syncPurchaseRequests.mockResolvedValueOnce(
      summary('partial', { pagesFailed: 3 }),
    );

    const run = scheduler.fullDailyTick();
    await jest.advanceTimersByTimeAsync(2 * FULL_DAILY_FAILURE_RETRY_MS);
    await run;
    expect(syncService.syncPurchaseOrders).toHaveBeenCalledTimes(2);
    expect(syncService.syncPurchaseRequests).toHaveBeenCalledTimes(2);
    expect(lines.join('\n')).toContain(
      'full diario: purchase_orders falló (login del Service Layer: 401) — reintento en 15 min (1/8)',
    );
  });

  it('un partial solo por documentos que no se guardaron no se reintenta (fallaría igual)', async () => {
    const { scheduler, syncService, lines } = makeScheduler();
    syncService.syncPurchaseOrders.mockResolvedValueOnce(
      summary('partial', { recordsFailed: 2 }),
    );

    await scheduler.fullDailyTick();
    expect(syncService.syncPurchaseOrders).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toContain(
      'purchase_orders terminó partial por documentos que no se guardaron (corrida run-partial); no se reintenta',
    );
    expect(syncService.syncPurchaseRequests).toHaveBeenCalledTimes(1);
  });

  it('tras FULL_DAILY_FAILURE_MAX_RETRIES reintentos (~2 h) se omite hasta mañana y siguen los demás targets', async () => {
    jest.useFakeTimers({ now: BEFORE_3AM_MX });
    const { scheduler, syncService, lines } = makeScheduler();
    syncService.syncPurchaseOrders.mockResolvedValue(summary('failed'));

    const run = scheduler.fullDailyTick();
    await jest.advanceTimersByTimeAsync(
      FULL_DAILY_FAILURE_RETRY_MS * FULL_DAILY_FAILURE_MAX_RETRIES,
    );
    await run;
    expect(syncService.syncPurchaseOrders).toHaveBeenCalledTimes(
      1 + FULL_DAILY_FAILURE_MAX_RETRIES,
    );
    expect(lines.join('\n')).toContain(
      `full diario: purchase_orders falló ${1 + FULL_DAILY_FAILURE_MAX_RETRIES} veces`,
    );
    expect(syncService.syncPurchaseRequests).toHaveBeenCalledTimes(1);
    expect(syncService.syncBusinessPartners).toHaveBeenCalledTimes(1);
  });

  it('no se enciman dos pasadas: con una en curso, la que llega se omite', async () => {
    const { scheduler, syncService, lines } = makeScheduler();
    let finish!: () => void;
    syncService.syncPurchaseOrders.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve(summary('success'));
      }),
    );

    const first = scheduler.fullDailyTick();
    await scheduler.fullDailyTick();
    expect(lines.join('\n')).toContain(
      'full diario: ya hay una pasada en curso — se omite esta',
    );
    expect(syncService.syncPurchaseOrders).toHaveBeenCalledTimes(1);

    finish();
    await first;
    expect(syncService.syncPurchaseRequests).toHaveBeenCalledTimes(1);
  });
});

describe('SapSyncScheduler — recuperación al arrancar (L1)', () => {
  it('tras el jitter y el primer tick corre una vez el full de los targets sin full exitoso en 24 h', async () => {
    // mediodía en México: lejos del cron de las 03:00
    const noonMx = new Date('2026-10-08T18:00:00Z');
    jest.useFakeTimers({ now: noonMx });
    jest.spyOn(Math, 'random').mockReturnValue(0); // jitter = 30 s
    const { scheduler, syncService, registry, lines } = makeScheduler({
      lastFull: {
        purchase_orders: new Date(noonMx.getTime() - 25 * HOUR_MS),
        purchase_requests: new Date(noonMx.getTime() - HOUR_MS),
        business_partners: null,
      },
    });
    try {
      scheduler.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(29_000);
      expect(syncService.syncPurchaseOrders).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1_000);
      const full = ['cron', null, 'full'];
      // primero el tick (incremental) y después la recuperación (full)
      expect(syncService.syncPurchaseOrders.mock.calls).toEqual([
        ['cron'],
        full,
      ]);
      expect(syncService.syncPurchaseRequests.mock.calls).toEqual([['cron']]);
      expect(syncService.syncBusinessPartners.mock.calls).toEqual([
        ['cron'],
        full,
      ]);
      expect(
        syncService.syncApprovalRequests.mock.invocationCallOrder[0],
      ).toBeLessThan(
        syncService.syncPurchaseOrders.mock.invocationCallOrder[1],
      );
      expect(lines.join('\n')).toContain(
        'recuperación del full diario al arrancar: purchase_orders, business_partners sin full exitoso en 24 h',
      );
    } finally {
      clearRegistry(registry);
    }
  });

  it('con el último full exitoso de menos de 24 h no corre nada', async () => {
    const { scheduler, syncService, lines } = makeScheduler({
      lastFull: {
        purchase_orders: new Date(Date.now() - 23 * HOUR_MS),
        purchase_requests: new Date(Date.now() - HOUR_MS),
        business_partners: new Date(),
      },
    });
    await scheduler.recoverFullDaily();
    expect(syncService.lastFullSuccessAt).toHaveBeenCalledTimes(3);
    expect(syncService.syncPurchaseOrders).not.toHaveBeenCalled();
    expect(syncService.syncPurchaseRequests).not.toHaveBeenCalled();
    expect(syncService.syncBusinessPartners).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('recuperación del full diario: al día');
  });

  it('con SAP_SYNC_FULL_DAILY_AT=off no hay recuperación (ni siquiera consulta)', async () => {
    const { scheduler, syncService } = makeScheduler({
      fullDailyAt: null,
      lastFull: { purchase_orders: null },
    });
    await scheduler.recoverFullDaily();
    expect(syncService.lastFullSuccessAt).not.toHaveBeenCalled();
    expect(syncService.syncPurchaseOrders).not.toHaveBeenCalled();
  });

  it('si no se puede leer el último full, lo registra y no revienta', async () => {
    const { scheduler, syncService, lines } = makeScheduler();
    syncService.lastFullSuccessAt.mockRejectedValueOnce(new Error('BD caída'));
    await expect(scheduler.recoverFullDaily()).resolves.toBeUndefined();
    expect(syncService.syncPurchaseOrders).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain(
      'recuperación del full diario: no se pudo leer el último full: BD caída',
    );
  });
});

describe('SapSyncScheduler + motor real (L1, de punta a punta)', () => {
  /** Staging de un documento por DocEntry. */
  const stagingRow = (rows: Array<Record<string, unknown>>, docEntry: number) =>
    rows.find((r) => r.doc_entry === docEntry)!;
  /** Corridas del cron de un target, en orden: [modo, estatus]. */
  const cronRuns = (
    h: ReturnType<typeof makeSapSyncHarness>,
    target: SapSyncTarget,
  ) =>
    h.prisma.sap_sync_runs.rows
      .filter((r) => r.target === target && r.triggered_by === 'cron')
      .map((r) => [r.mode, r.status]);

  it('una OC y una solicitud que SAP cierra sin mover UpdateDate siguen abiertas tras el incremental y quedan cerradas tras el full diario', async () => {
    const h = makeSapSyncHarness();
    // OC 100 y solicitud 200, viejas; OC 101 y solicitud 201, recientes
    h.sap.add(
      'purchase_orders',
      sapDoc(100, '2026-09-01'),
      sapDoc(101, '2026-10-07'),
    );
    h.sap.add(
      'purchase_requests',
      sapDoc(200, '2026-09-02'),
      sapDoc(201, '2026-10-07'),
    );
    await h.service.syncPurchaseOrders('manual', null, 'full');
    await h.service.syncPurchaseRequests('manual', null, 'full');

    // La entrada de mercancía cierra la OC 100 y la OC cierra la solicitud
    // 200; SAP no cambia el UpdateDate de ninguna de las dos.
    const closed = {
      DocumentStatus: 'bost_Close',
      DocumentLines: [{ LineNum: 0, LineTotal: 100, LineStatus: 'bost_Close' }],
    };
    h.sap.update('purchase_orders', 100, closed);
    h.sap.update('purchase_requests', 200, closed);

    // incremental horario: corte = 2026-10-07 − 2 días → no los relee
    await h.scheduler.tick();
    const incremental = h.prisma.sap_sync_runs.rows.filter(
      (r) => r.mode === 'incremental',
    );
    expect(incremental.map((r) => [r.target, r.status])).toEqual([
      ['purchase_orders', 'success'],
      ['purchase_requests', 'success'],
    ]);
    expect(incremental[0].since_filter).toEqual(
      new Date('2026-10-05T00:00:00Z'),
    );
    const po = h.prisma.sap_purchase_orders.rows;
    const pr = h.prisma.sap_purchase_requests.rows;
    expect(stagingRow(po, 100).document_status).toBe('bost_Open');
    expect(stagingRow(pr, 200).document_status).toBe('bost_Open');

    await h.scheduler.fullDailyTick();
    expect(stagingRow(po, 100).document_status).toBe('bost_Close');
    expect(stagingRow(pr, 200).document_status).toBe('bost_Close');
    // es un cambio real en SAP (otro raw): 'updated' con last_changed_at
    expect(stagingRow(po, 100).last_changed_at).toBeInstanceOf(Date);
    expect(stagingRow(po, 101).last_changed_at).toBeNull();
    // (proveedores y autorizaciones también corren en full; no se miran aquí)
    const fulls = h.prisma.sap_sync_runs.rows.filter(
      (r) =>
        r.mode === 'full' &&
        r.triggered_by === 'cron' &&
        (r.target === 'purchase_orders' || r.target === 'purchase_requests'),
    );
    expect(
      fulls.map((r) => ({
        target: r.target,
        status: r.status,
        since_filter: r.since_filter,
        records_updated: r.records_updated,
        records_unchanged: r.records_unchanged,
      })),
    ).toEqual([
      {
        target: 'purchase_orders',
        status: 'success',
        since_filter: null,
        records_updated: 1,
        records_unchanged: 1,
      },
      {
        target: 'purchase_requests',
        status: 'success',
        since_filter: null,
        records_updated: 1,
        records_unchanged: 1,
      },
    ]);
  });

  it('respeta el mutex: con el incremental de OC en curso, el full diario espera a que termine y nunca corren dos a la vez', async () => {
    jest.useFakeTimers({ now: BEFORE_3AM_MX });
    const h = makeSapSyncHarness();
    h.sap.add(
      'purchase_orders',
      sapDoc(100, '2026-09-01'),
      sapDoc(101, '2026-10-07'),
      sapDoc(102, '2026-10-07'),
    );
    await h.service.syncPurchaseOrders('manual', null, 'full');

    const held = h.sap.hold('purchase_orders');
    const incremental = h.service.syncPurchaseOrders('cron');
    await held.entered;
    expect(h.service.isRunning('purchase_orders')).toBe(true);

    const daily = h.scheduler.fullDailyTick();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.lines.join('\n')).toContain(
      'full diario: corrida de purchase_orders en curso — reintento en 60 s',
    );
    // mientras el incremental sigue, el full no abrió corrida
    expect(
      h.prisma.sap_sync_runs.rows.filter((r) => r.triggered_by === 'cron'),
    ).toHaveLength(1);

    held.release();
    const incrementalSummary = await incremental;
    expect(incrementalSummary.mode).toBe('incremental');

    await jest.advanceTimersByTimeAsync(FULL_DAILY_BUSY_RETRY_MS);
    await daily;
    expect(h.sap.maxInFlight.purchase_orders).toBe(1);
    const cronPo = h.prisma.sap_sync_runs.rows.filter(
      (r) => r.target === 'purchase_orders' && r.triggered_by === 'cron',
    );
    expect(cronPo.map((r) => [r.mode, r.status])).toEqual([
      ['incremental', 'success'],
      ['full', 'success'],
    ]);
    // el full arrancó después de que terminó el incremental
    expect((cronPo[1].started_at as Date).getTime()).toBeGreaterThanOrEqual(
      (cronPo[0].finished_at as Date).getTime(),
    );
  });

  it('el SL no responde en el primer intento del full diario (corrida failed) y el reintento a los 15 min termina en success', async () => {
    jest.useFakeTimers({ now: BEFORE_3AM_MX });
    const h = makeSapSyncHarness();
    h.sap.add(
      'purchase_orders',
      sapDoc(100, '2026-09-01'),
      sapDoc(101, '2026-10-07'),
    );
    await h.service.syncPurchaseOrders('manual', null, 'full');
    h.sap.update('purchase_orders', 100, { DocumentStatus: 'bost_Close' });

    h.sap.down = true;
    const daily = h.scheduler.fullDailyTick();
    await jest.advanceTimersByTimeAsync(0);
    expect(cronRuns(h, 'purchase_orders')).toEqual([['full', 'failed']]);
    expect(h.lines.join('\n')).toContain(
      'full diario: purchase_orders falló (corrida',
    );
    expect(h.lines.join('\n')).toContain('reintento en 15 min (1/8)');
    const po = h.prisma.sap_purchase_orders.rows;
    expect(stagingRow(po, 100).document_status).toBe('bost_Open');

    h.sap.down = false; // el SL vuelve
    await jest.advanceTimersByTimeAsync(FULL_DAILY_FAILURE_RETRY_MS);
    await daily;
    expect(cronRuns(h, 'purchase_orders')).toEqual([
      ['full', 'failed'],
      ['full', 'success'],
    ]);
    expect(stagingRow(po, 100).document_status).toBe('bost_Close');
    // después, solicitudes y proveedores en su turno
    expect(cronRuns(h, 'purchase_requests')).toEqual([['full', 'success']]);
    expect(cronRuns(h, 'business_partners')).toEqual([['full', 'success']]);
  });

  it('recuperación con el motor real: recién hecho el full no corre nada; 25 h después corre el full de OC, solicitudes y proveedores', async () => {
    jest.useFakeTimers({ now: BEFORE_3AM_MX });
    const h = makeSapSyncHarness();
    h.sap.add('purchase_orders', sapDoc(100, '2026-09-01'));
    h.sap.add('purchase_requests', sapDoc(200, '2026-09-02'));
    await h.service.syncPurchaseOrders('manual', null, 'full');
    await h.service.syncPurchaseRequests('manual', null, 'full');
    await h.service.syncBusinessPartners('manual', null, 'full');

    jest.setSystemTime(BEFORE_3AM_MX.getTime() + HOUR_MS);
    await h.scheduler.recoverFullDaily();
    expect(
      h.prisma.sap_sync_runs.rows.filter((r) => r.triggered_by === 'cron'),
    ).toHaveLength(0);

    jest.setSystemTime(BEFORE_3AM_MX.getTime() + 25 * HOUR_MS);
    await h.scheduler.recoverFullDaily();
    for (const target of SAP_FULL_DAILY_TARGETS) {
      expect(cronRuns(h, target)).toEqual([['full', 'success']]);
    }
  });

  it('si el catálogo de usuarios no carga, la OC existente conserva created_by_name (updated o remapped) y la nueva queda en null', async () => {
    const h = makeSapSyncHarness();
    h.sap.users = [{ InternalKey: 7, UserName: 'Ingrid Pérez' }];
    h.sap.add(
      'purchase_orders',
      sapDoc(100, '2026-09-01', { UserSign: 7 }),
      sapDoc(101, '2026-09-01', { UserSign: 7 }),
    );
    await h.service.syncPurchaseOrders('manual', null, 'full');
    const po = h.prisma.sap_purchase_orders.rows;
    expect(stagingRow(po, 100).created_by_name).toBe('Ingrid Pérez');

    h.sap.usersFail = true;
    h.sap.update('purchase_orders', 100, { DocumentStatus: 'bost_Close' }); // updated
    stagingRow(po, 101).mapper_version = '1.2.0'; // remapped
    h.sap.add('purchase_orders', sapDoc(102, '2026-10-07', { UserSign: 7 }));

    await h.scheduler.fullDailyTick();
    expect(h.lines.join('\n')).toContain('catálogo de usuarios SAP falló');
    const run = h.prisma.sap_sync_runs.rows.find(
      (r) => r.target === 'purchase_orders' && r.triggered_by === 'cron',
    )!;
    expect(run).toMatchObject({
      status: 'success',
      records_updated: 1,
      records_remapped: 1,
      records_inserted: 1,
    });
    expect(stagingRow(po, 100)).toMatchObject({
      document_status: 'bost_Close',
      created_by_name: 'Ingrid Pérez',
    });
    expect(stagingRow(po, 101)).toMatchObject({
      mapper_version: SAP_MAPPER_VERSION,
      created_by_name: 'Ingrid Pérez',
    });
    expect(stagingRow(po, 102).created_by_name ?? null).toBeNull();
  });

  it("subir el mapper con el mismo raw: el full diario las cuenta en records_remapped (no 'updated') y no mueve last_changed_at", async () => {
    const h = makeSapSyncHarness();
    h.sap.add(
      'purchase_orders',
      sapDoc(100, '2026-09-01'),
      sapDoc(101, '2026-10-07'),
      sapDoc(102, '2026-10-07'),
    );
    await h.service.syncPurchaseOrders('manual', null, 'full');
    // filas escritas por el mapper anterior, con un cambio real ya registrado
    const changedAt = new Date('2026-09-23T17:00:00Z');
    for (const row of h.prisma.sap_purchase_orders.rows) {
      row.mapper_version = '1.2.0';
      row.subtotal = null;
      row.last_changed_at = changedAt;
    }

    await h.scheduler.fullDailyTick();
    const run = h.prisma.sap_sync_runs.rows.find(
      (r) => r.target === 'purchase_orders' && r.triggered_by === 'cron',
    )!;
    expect(run).toMatchObject({
      mode: 'full',
      status: 'success',
      records_remapped: 3,
      records_updated: 0,
      records_unchanged: 0,
    });
    expect(h.lines.join('\n')).toContain(
      'updated=0 remapped=3 unchanged=0 failed=0',
    );
    for (const row of h.prisma.sap_purchase_orders.rows) {
      expect(row.mapper_version).toBe(SAP_MAPPER_VERSION);
      expect(row.subtotal).toBe(100); // columnas re-mapeadas
      expect(row.last_changed_at).toBe(changedAt);
      expect(row.last_sync_run_id).toBe(run.id);
    }
  });
});
