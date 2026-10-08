import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../../../../prisma/prisma.service';
import type { LoggerLike } from '../../../common';
import { SapClient } from '../../sap.client';
import type { SapFetchParams } from '../../sap.client';
import { toSapPurchaseOrder, toSapPurchaseRequest } from '../../sap.mapper';
import { SapStagingService } from '../sap-staging.service';
import { SapSyncService } from '../sap-sync.service';
import { SapSyncScheduler } from '../sap-sync.scheduler';
import type { SapSyncConfig } from '../sap-sync.config';

/**
 * Utilería de tests del sync de SAP (L1, 2026-10-08). Solo la consumen los
 * `*.spec.ts` de esta carpeta; no hay red ni base real (el archivo compila a
 * dist sin efecto: nada de producción lo importa).
 *
 * - `FakeSapPrisma`: Prisma en memoria con el subconjunto que usan el motor,
 *   staging y status. `where` entiende igualdad y `{ not }`; `orderBy`, un
 *   campo (empate: la fila insertada después va primero, como una corrida
 *   posterior); `aggregate`, solo `_max`. Como Prisma, un valor `undefined`
 *   en `data` no se escribe. Las filas se copian en superficie (sin
 *   structuredClone: las fechas siguen siendo `Date` del mismo realm).
 * - `FakeSapServiceLayer`: el Service Layer simulado con el contrato de
 *   `SapClient` para OC y solicitudes en memoria: `$orderby=DocEntry`,
 *   `$top/$skip`, `/$count` y `UpdateDate ge <día>` con el mismo corte por día
 *   (UTC) que `sap.client.ts`. Los DTO salen del mapper real. Simula también
 *   el catálogo Users (`users`, `usersFail`) y un SL caído (`down`).
 *   Proveedores y cola de autorización vienen vacíos (el tick horario y el
 *   full diario también los corren).
 */

type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

function isDateLike(value: unknown): value is Date {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Date).getTime === 'function'
  );
}

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (
      cond !== null &&
      typeof cond === 'object' &&
      !isDateLike(cond) &&
      'not' in cond
    ) {
      return row[key] !== (cond as { not: unknown }).not;
    }
    return row[key] === cond;
  });
}

function sortKey(value: unknown): number | string {
  if (isDateLike(value)) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string') return value;
  return Number.NEGATIVE_INFINITY;
}

function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [key, on] of Object.entries(select)) if (on) out[key] = row[key];
  return out as Row;
}

/** Como Prisma: un campo `undefined` en `data` no se escribe. */
function definedOnly(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

export class FakeSapTable {
  rows: Row[] = [];
  private seq = 0;

  constructor(
    private readonly prefix: string,
    private readonly defaults: () => Record<string, unknown> = () => ({}),
  ) {}

  create = jest.fn(
    ({
      data,
      select,
    }: {
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => {
      const row: Row = {
        id: `${this.prefix}-${++this.seq}`,
        ...this.defaults(),
        ...definedOnly(data),
      };
      this.rows.push(row);
      return Promise.resolve(pick(row, select));
    },
  );

  findFirst = jest.fn(
    (
      args: {
        where?: Where;
        orderBy?: Record<string, 'asc' | 'desc'>;
        select?: Record<string, boolean>;
      } = {},
    ) => {
      const found = this.sorted(args.where, args.orderBy);
      return Promise.resolve(found.length ? pick(found[0], args.select) : null);
    },
  );

  findMany = jest.fn(
    (
      args: {
        where?: Where;
        orderBy?: Record<string, 'asc' | 'desc'>;
        skip?: number;
        take?: number;
      } = {},
    ) => {
      const start = args.skip ?? 0;
      const rows = this.sorted(args.where, args.orderBy).slice(
        start,
        args.take === undefined ? undefined : start + args.take,
      );
      return Promise.resolve(rows.map((r) => ({ ...r })));
    },
  );

  update = jest.fn(
    ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = this.rows.find((r) => r.id === where.id);
      if (!row) return Promise.reject(new Error(`fila ${where.id} no existe`));
      Object.assign(row, definedOnly(data));
      return Promise.resolve({ ...row });
    },
  );

  count = jest.fn((args: { where?: Where } = {}) =>
    Promise.resolve(this.rows.filter((r) => matches(r, args.where)).length),
  );

  aggregate = jest.fn((args: { _max: Record<string, boolean> }) => {
    const max: Record<string, unknown> = {};
    for (const field of Object.keys(args._max)) {
      let best: unknown = null;
      for (const row of this.rows) {
        const value = row[field];
        if (value === null || value === undefined) continue;
        if (best === null || sortKey(value) > sortKey(best)) best = value;
      }
      max[field] = best;
    }
    return Promise.resolve({ _max: max });
  });

  /** Filas que cumplen `where`, ordenadas; sin orderBy, en orden de alta. */
  private sorted(
    where?: Where,
    orderBy?: Record<string, 'asc' | 'desc'>,
  ): Row[] {
    const indexed = this.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => matches(row, where));
    const [field, direction] = Object.entries(orderBy ?? {})[0] ?? [];
    if (field) {
      const sign = direction === 'desc' ? -1 : 1;
      indexed.sort((a, b) => {
        const ka = sortKey(a.row[field]);
        const kb = sortKey(b.row[field]);
        if (ka !== kb) return ka < kb ? -sign : sign;
        return b.index - a.index; // empate: la más reciente primero
      });
    }
    return indexed.map(({ row }) => row);
  }
}

const stagingDefaults = () => ({
  first_seen_at: new Date(),
  last_seen_at: new Date(),
  last_changed_at: null,
});

export class FakeSapPrisma {
  sap_sync_runs = new FakeSapTable('run', () => ({
    started_at: new Date(),
    finished_at: null,
    status: 'running',
    pages_total: null,
    pages_ok: 0,
    records_fetched: 0,
    records_inserted: 0,
    records_updated: 0,
    records_remapped: 0,
    records_unchanged: 0,
    records_failed: 0,
    error_summary: null,
  }));
  sap_purchase_orders = new FakeSapTable('po', stagingDefaults);
  sap_purchase_requests = new FakeSapTable('pr', stagingDefaults);
  sap_business_partners = new FakeSapTable('bp', stagingDefaults);
  sap_approval_requests = new FakeSapTable('ar', stagingDefaults);

  asService(): PrismaService {
    return this as unknown as PrismaService;
  }
}

export type SapDocEntity = 'purchase_orders' | 'purchase_requests';
type SapRawDoc = Record<string, unknown> & {
  DocEntry: number;
  UpdateDate: string;
};

const HTTP_OK = { status: 200, durationMs: 1, attempts: 1 };

export class FakeSapServiceLayer {
  /** Documentos "en SAP" por entidad; `update` los cambia como lo haría SAP. */
  readonly docs: Record<SapDocEntity, SapRawDoc[]> = {
    purchase_orders: [],
    purchase_requests: [],
  };
  /** Páginas pedidas (entidad, skip y corte) en orden. */
  readonly fetches: Array<{
    entity: SapDocEntity;
    skip: number;
    updatedSince?: Date;
  }> = [];
  /** Máximo de páginas en vuelo a la vez por entidad (dos corridas = 2). */
  readonly maxInFlight: Record<SapDocEntity, number> = {
    purchase_orders: 0,
    purchase_requests: 0,
  };
  private readonly inFlight: Record<SapDocEntity, number> = {
    purchase_orders: 0,
    purchase_requests: 0,
  };
  /** Catálogo Users (InternalKey → UserName) y si su lectura falla. */
  users: Array<Record<string, unknown>> = [];
  usersFail = false;
  /** SL caído: mientras sea true, toda página de OC o solicitudes falla. */
  down = false;
  private held: {
    entity: SapDocEntity;
    entered: () => void;
    gate: Promise<void>;
  } | null = null;

  add(entity: SapDocEntity, ...docs: SapRawDoc[]): void {
    this.docs[entity].push(...docs);
  }

  /** Cambia un documento EN SAP; `UpdateDate` solo se mueve si viene en el patch. */
  update(
    entity: SapDocEntity,
    docEntry: number,
    patch: Record<string, unknown>,
  ): void {
    const list = this.docs[entity];
    const index = list.findIndex((d) => d.DocEntry === docEntry);
    if (index < 0) throw new Error(`DocEntry ${docEntry} no existe`);
    list[index] = { ...list[index], ...patch };
  }

  /**
   * La siguiente página de `entity` se queda esperando hasta `release()`
   * (una corrida "en curso"); `entered` se resuelve cuando la pide.
   */
  hold(entity: SapDocEntity): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.held = { entity, entered, gate };
    return { entered: enteredPromise, release };
  }

  asClient(): SapClient {
    const client = {
      countPurchaseOrders: (since?: Date) =>
        Promise.resolve(this.visible('purchase_orders', since).length),
      countPurchaseRequests: (since?: Date) =>
        Promise.resolve(this.visible('purchase_requests', since).length),
      fetchPurchaseOrders: async (params: SapFetchParams) => {
        const raw = await this.page('purchase_orders', params);
        return { records: raw.map(toSapPurchaseOrder), raw, http: HTTP_OK };
      },
      fetchPurchaseRequests: async (params: SapFetchParams) => {
        const raw = await this.page('purchase_requests', params);
        return { records: raw.map(toSapPurchaseRequest), raw, http: HTTP_OK };
      },
      countBusinessPartners: () => Promise.resolve(0),
      fetchBusinessPartners: () =>
        Promise.resolve({ records: [], raw: [], http: HTTP_OK }),
      countApprovalRequests: () => Promise.resolve(0),
      fetchApprovalRequests: () => Promise.resolve({ raw: [], http: HTTP_OK }),
      fetchAllUsers: () =>
        this.usersFail
          ? Promise.reject(new Error('Users: 503 (simulado)'))
          : Promise.resolve(this.users.map((u) => ({ ...u }))),
      fetchAllDraftsSlim: () => Promise.resolve([]),
      fetchAllApprovalStages: () => Promise.resolve([]),
      fetchAllApprovalTemplates: () => Promise.resolve([]),
    };
    return client as unknown as SapClient;
  }

  /** `UpdateDate ge <día>`: mismo corte por día (UTC) que `sap.client.ts`. */
  private visible(entity: SapDocEntity, since?: Date): SapRawDoc[] {
    const day = since ? since.toISOString().slice(0, 10) : null;
    return this.docs[entity]
      .filter((d) => day === null || d.UpdateDate.slice(0, 10) >= day)
      .sort((a, b) => a.DocEntry - b.DocEntry);
  }

  private async page(
    entity: SapDocEntity,
    params: SapFetchParams,
  ): Promise<unknown[]> {
    this.fetches.push({
      entity,
      skip: params.skip,
      updatedSince: params.updatedSince,
    });
    this.inFlight[entity] += 1;
    this.maxInFlight[entity] = Math.max(
      this.maxInFlight[entity],
      this.inFlight[entity],
    );
    try {
      if (this.down) throw new Error('Service Layer no responde (simulado)');
      const held = this.held;
      if (held && held.entity === entity) {
        this.held = null;
        held.entered();
        await held.gate;
      }
      // copia: el raw guardado en staging no cambia si luego cambia "SAP"
      return this.visible(entity, params.updatedSince)
        .slice(params.skip, params.skip + params.top)
        .map((d) => JSON.parse(JSON.stringify(d)) as unknown);
    } finally {
      this.inFlight[entity] -= 1;
    }
  }
}

export function silentLogger(lines: string[] = []): LoggerLike {
  return {
    log: (m) => lines.push(`LOG ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m) => lines.push(`ERROR ${m}`),
    debug: (m) => lines.push(`DEBUG ${m}`),
  };
}

/** OC o solicitud cruda mínima (lo que el mapper lee), abierta por default. */
export function sapDoc(
  docEntry: number,
  updateDay: string,
  over: Record<string, unknown> = {},
): SapRawDoc {
  return {
    DocEntry: docEntry,
    DocNum: 5000 + docEntry,
    DocDate: `${updateDay}T00:00:00Z`,
    UpdateDate: `${updateDay}T00:00:00Z`,
    DocumentStatus: 'bost_Open',
    Cancelled: 'tNO',
    DocCurrency: 'MXN',
    DocTotal: 116,
    DocumentLines: [{ LineNum: 0, LineTotal: 100, LineStatus: 'bost_Open' }],
    ...over,
  };
}

/**
 * Motor real (scheduler + sync + staging) sobre Prisma en memoria y el
 * Service Layer simulado. Página de 2 para que haya paginación.
 */
export function makeSapSyncHarness(
  opts: { enabled?: boolean; fullDailyAt?: string | null } = {},
) {
  const prisma = new FakeSapPrisma();
  const sap = new FakeSapServiceLayer();
  const lines: string[] = [];
  const logger = silentLogger(lines);
  const config: SapSyncConfig = {
    enabled: opts.enabled ?? true,
    intervalMinutes: 60,
    pageSize: 2,
    fullDailyAt: opts.fullDailyAt === undefined ? '03:00' : opts.fullDailyAt,
  };
  const staging = new SapStagingService(prisma.asService());
  const service = new SapSyncService(
    prisma.asService(),
    sap.asClient(),
    staging,
    config,
    logger,
  );
  const registry = new SchedulerRegistry();
  const scheduler = new SapSyncScheduler(service, registry, config, logger);
  return { prisma, sap, lines, config, staging, service, registry, scheduler };
}

/** Detiene y quita lo que registró el scheduler (cron, timeout, interval). */
export function clearRegistry(registry: SchedulerRegistry): void {
  for (const name of [...registry.getCronJobs().keys()]) {
    registry.deleteCronJob(name);
  }
  for (const name of registry.getTimeouts()) registry.deleteTimeout(name);
  for (const name of registry.getIntervals()) registry.deleteInterval(name);
}
