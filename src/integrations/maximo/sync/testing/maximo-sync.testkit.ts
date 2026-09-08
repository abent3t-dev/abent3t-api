import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../../../../prisma/prisma.service';
import type { LoggerLike } from '../../../common';
import { MaximoFetchResult } from '../../maximo.client';
import { MaximoPurchaseOrderDto } from '../../dto/maximo-po.dto';
import {
  parseLegacyEnvelope,
  parseOslcEnvelope,
  toPurchaseOrder,
} from '../../maximo.mapper';

/**
 * Utilería de tests del sync (Fase INT-3). Solo la consumen los `*.spec.ts`
 * de esta carpeta; no hay red ni base real: Prisma se simula en memoria con
 * el subconjunto de la API que usa el engine. (El archivo compila a dist sin
 * efecto: nada de producción lo importa.)
 */

type Row = Record<string, unknown> & { id: string };

let idSeq = 0;
const nextId = (): string =>
  `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (
      cond !== null &&
      typeof cond === 'object' &&
      'in' in (cond as Record<string, unknown>)
    ) {
      return ((cond as { in: unknown[] }).in ?? []).includes(row[key]);
    }
    return row[key] === cond;
  });
}

/**
 * Como matches(), pero además soporta el operador { lt } sobre fechas.
 * Nota: en la VM de jest, structuredClone devuelve Dates de OTRO realm
 * (instanceof Date === false), así que se compara por getTime() (duck typing).
 */
function timestampOf(value: unknown): number {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Date).getTime === 'function'
  ) {
    return (value as Date).getTime();
  }
  return Number.NaN;
}

function matchesExtended(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (
      cond !== null &&
      typeof cond === 'object' &&
      'lt' in (cond as Record<string, unknown>)
    ) {
      return timestampOf(row[key]) < timestampOf((cond as { lt: unknown }).lt);
    }
    return matches(row, { [key]: cond });
  });
}

class FakeTable {
  rows: Row[] = [];

  create = jest.fn(
    ({ data, select }: { data: Record<string, unknown>; select?: unknown }) => {
      const row: Row = {
        id: nextId(),
        status: 'running',
        ...structuredClone(data),
      };
      this.rows.push(row);
      return Promise.resolve(select ? { id: row.id } : structuredClone(row));
    },
  );

  findFirst = jest.fn(
    (args: { where?: Record<string, unknown>; orderBy?: unknown } = {}) => {
      const found = this.rows.filter((r) => matches(r, args.where ?? {}));
      return Promise.resolve(
        found.length ? structuredClone(found[found.length - 1]) : null,
      );
    },
  );

  findMany = jest.fn(
    (
      args: {
        where?: Record<string, unknown>;
        take?: number;
        skip?: number;
        cursor?: { id: string };
      } = {},
    ) => {
      let rows = this.rows.filter((r) => matches(r, args.where ?? {}));
      rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
      if (args.cursor) {
        const idx = rows.findIndex((r) => r.id === args.cursor?.id);
        rows = idx >= 0 ? rows.slice(idx + (args.skip ?? 0)) : [];
      } else if (args.skip) {
        rows = rows.slice(args.skip);
      }
      if (args.take !== undefined) rows = rows.slice(0, args.take);
      return Promise.resolve(structuredClone(rows));
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
      Object.assign(row, structuredClone(data));
      return Promise.resolve(structuredClone(row));
    },
  );

  count = jest.fn((args: { where?: Record<string, unknown> } = {}) =>
    Promise.resolve(
      this.rows.filter((r) => matches(r, args.where ?? {})).length,
    ),
  );

  updateMany = jest.fn(
    ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      let count = 0;
      for (const row of this.rows) {
        if (!matchesExtended(row, where)) continue;
        Object.assign(row, structuredClone(data));
        count += 1;
      }
      return Promise.resolve({ count });
    },
  );

  deleteMany = jest.fn(({ where }: { where: Record<string, unknown> }) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    return Promise.resolve({ count: before - this.rows.length });
  });
}

export class FakePrisma {
  maximo_sync_runs = new FakeTable();
  maximo_purchase_orders = new FakeTable();
  maximo_contracts = new FakeTable();

  asService(): PrismaService {
    return this as unknown as PrismaService;
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

const FIXTURES_DIR = join(__dirname, '..', '..', '__fixtures__');

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

/** Construye un MaximoFetchResult de POs desde un fixture legacy (sin red). */
export function poPageFromLegacyFixture(
  name: string,
  overrides: Partial<MaximoFetchResult<MaximoPurchaseOrderDto>> = {},
): MaximoFetchResult<MaximoPurchaseOrderDto> {
  const { records, page } = parseLegacyEnvelope(fixture(name), 'AB_COMPRAS');
  return {
    objectStructure: 'AB_COMPRAS',
    api: 'legacy',
    records: records.map(toPurchaseOrder),
    raw: records,
    legacyPage: page,
    oslcPage: null,
    filterCheck: {
      kind: 'none',
      applied: true,
      violations: 0,
      unverifiable: 0,
      description: 'sin filtro',
    },
    http: { status: 200, durationMs: 1, attempts: 1 },
    ...overrides,
  };
}

/** Página de contratos: DTOs "vigentes" + raw completo (el engine re-mapea). */
export function contractPageFromFixture(
  name: string,
  api: 'legacy' | 'oslc' = 'legacy',
): MaximoFetchResult<unknown> {
  const body = fixture(name);
  const parsed =
    api === 'legacy'
      ? parseLegacyEnvelope(body, 'AB_CONTRATOS')
      : { records: parseOslcEnvelope(body).records, page: null };
  return {
    objectStructure: 'AB_CONTRATOS',
    api,
    records: [],
    raw: parsed.records,
    legacyPage:
      api === 'legacy'
        ? (
            parsed as {
              page: {
                rsStart: number | null;
                rsCount: number | null;
                rsTotal: number | null;
              };
            }
          ).page
        : null,
    oslcPage: null,
    filterCheck: {
      kind: 'none',
      applied: true,
      violations: 0,
      unverifiable: 0,
      description: 'sin filtro',
    },
    http: { status: 200, durationMs: 1, attempts: 1 },
  };
}
