import { BadRequestException } from '@nestjs/common';

/**
 * E1 (Ingrid y César, 2026-09-25) — Filtro "tipo Excel" por columna.
 *
 * Un solo motor para todas las tablas de Compras: cada módulo declara sus
 * columnas filtrables con el valor que la tabla MUESTRA (el estatus
 * derivado, "Capturó: …", el saldo calculado…) y este helper filtra,
 * ordena, pagina y arma las facetas. Se evalúa en memoria sobre las filas
 * que ya dejaron pasar los filtros propios del módulo (buscador, año,
 * origen, estatus), cargadas con el mismo loader del export (tope 20k):
 * así los valores derivados se filtran igual que se ven, sin duplicar su
 * regla en SQL, y el volumen de hoy (≤ ~5k filas por tabla) lo permite.
 *
 * Formato de `filters` (JSON en el query string; vive en la URL del front):
 *   { "proveedor": { "in":  ["A", "B", null] },    // null = "(Vacías)"
 *     "estatus":   { "nin": ["entregada"] },        // todo menos…
 *     "dias":      { "min": -400, "max": 0 },       // rango (número)
 *     "fecha":     { "min": "2026-01-01" },         // rango (YYYY-MM-DD)
 *     "saldo":     { "empty": true } }              // solo sin dato
 * y `sort=<columna>&order=asc|desc`. Las vacías siempre van al final.
 */

export type ColumnType = 'text' | 'number' | 'date';

export interface ColumnDef<T> {
  type: ColumnType;
  /** Valor que la tabla muestra para la fila (texto, número o fecha). */
  value: (row: T) => unknown;
}

export type ColumnDefs<T> = Record<string, ColumnDef<T>>;

/** Valor de una faceta de texto; null = "(Vacías)". */
export type FacetKey = string | null;

export type ColumnFilter =
  | { kind: 'values'; include: boolean; values: Set<FacetKey> }
  | {
      kind: 'range';
      min: number | string | null;
      max: number | string | null;
      empty: boolean;
    };

export interface ColumnQuery {
  filters: Map<string, ColumnFilter>;
  sort: { column: string; order: 'asc' | 'desc' } | null;
}

export interface ColumnQueryParams {
  filters?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface TextFacet {
  column: string;
  type: 'text';
  /** Ordenados por conteo (desc); tope FACET_LIMIT. */
  values: Array<{ value: FacetKey; count: number }>;
  /** Hay más valores distintos que el tope: buscar para acotar. */
  truncated: boolean;
  /** Filas consideradas (las que dejan pasar los demás filtros). */
  total: number;
}

export interface RangeFacet {
  column: string;
  type: 'number' | 'date';
  min: number | string | null;
  max: number | string | null;
  /** Filas con dato. */
  count: number;
  /** Filas sin dato. */
  empty: number;
  total: number;
}

export type ColumnFacet = TextFacet | RangeFacet;

export const FACET_LIMIT = 200;
const MAX_FILTER_VALUES = 1000;
const MAX_VALUE_LENGTH = 300;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const COLLATOR = new Intl.Collator('es', {
  sensitivity: 'base',
  numeric: true,
});

const CDMX_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// ── Normalización (la misma para filtrar, ordenar y armar facetas) ───────

/** Texto de la celda; vacío/espacios → null ("(Vacías)"). */
export function textKey(value: unknown): FacetKey {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (value instanceof Date) return dateKey(value);
  return null;
}

export function numberKey(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Día calendario `YYYY-MM-DD`. Las columnas `date` llegan en medianoche UTC
 * (se toma el día tal cual); un timestamp con hora se proyecta al día de
 * CDMX, que es el que muestra la tabla.
 */
export function dateKey(value: unknown): string | null {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string' && value !== '') date = new Date(value);
  else return null;
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return iso.endsWith('T00:00:00.000Z')
    ? iso.slice(0, 10)
    : CDMX_DAY.format(date);
}

function keyOf(type: ColumnType, value: unknown): string | number | null {
  if (type === 'number') return numberKey(value);
  if (type === 'date') return dateKey(value);
  return textKey(value);
}

/** Minúsculas y sin acentos, para buscar dentro de las facetas. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

// ── Parseo y validación del query string ────────────────────────────────

function bad(message: string): never {
  throw new BadRequestException(message);
}

function parseValues(column: string, raw: unknown): Set<FacetKey> {
  if (!Array.isArray(raw)) bad(`El filtro de "${column}" debe ser una lista`);
  if (raw.length > MAX_FILTER_VALUES) {
    bad(`El filtro de "${column}" trae demasiados valores`);
  }
  const values = new Set<FacetKey>();
  for (const item of raw as unknown[]) {
    if (item === null) {
      values.add(null);
      continue;
    }
    if (typeof item !== 'string' && typeof item !== 'number') {
      bad(`Valor inválido en el filtro de "${column}"`);
    }
    const text = String(item);
    if (text.length > MAX_VALUE_LENGTH) {
      bad(`Valor demasiado largo en el filtro de "${column}"`);
    }
    values.add(textKey(text));
  }
  return values;
}

function parseBound(
  column: string,
  type: ColumnType,
  raw: unknown,
): number | string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) bad(`Rango inválido en "${column}"`);
    return n;
  }
  if (typeof raw !== 'string' || !ISO_DAY.test(raw)) {
    bad(`Rango de fecha inválido en "${column}" (usa AAAA-MM-DD)`);
  }
  return raw;
}

function parseFilter(
  column: string,
  type: ColumnType,
  raw: unknown,
): ColumnFilter | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    bad(`Filtro inválido en "${column}"`);
  }
  const spec = raw as Record<string, unknown>;
  if (type === 'text') {
    const hasIn = spec.in !== undefined;
    const hasNin = spec.nin !== undefined;
    if (hasIn === hasNin) {
      bad(`El filtro de "${column}" lleva "in" o "nin" (uno de los dos)`);
    }
    return {
      kind: 'values',
      include: hasIn,
      values: parseValues(column, hasIn ? spec.in : spec.nin),
    };
  }
  const empty = spec.empty === true;
  const min = parseBound(column, type, spec.min);
  const max = parseBound(column, type, spec.max);
  if (!empty && min === null && max === null) return null; // rango abierto
  if (min !== null && max !== null && min > max) {
    bad(`En "${column}" el "desde" es mayor que el "hasta"`);
  }
  return { kind: 'range', min, max, empty };
}

/**
 * Valida `filters`/`sort`/`order` contra las columnas de la tabla. Una
 * columna que no existe, un JSON roto o un rango al revés → 400.
 */
export function parseColumnQuery<T>(
  params: ColumnQueryParams,
  defs: ColumnDefs<T>,
): ColumnQuery {
  const filters = new Map<string, ColumnFilter>();
  const raw = params.filters?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      bad('El parámetro "filters" no es JSON válido');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      bad('El parámetro "filters" debe ser un objeto por columna');
    }
    for (const [column, spec] of Object.entries(parsed)) {
      const def = Object.prototype.hasOwnProperty.call(defs, column)
        ? defs[column]
        : undefined;
      if (!def) bad(`No se puede filtrar por la columna "${column}"`);
      const filter = parseFilter(column, def.type, spec);
      if (filter) filters.set(column, filter);
    }
  }
  let sort: ColumnQuery['sort'] = null;
  if (params.sort) {
    if (!Object.prototype.hasOwnProperty.call(defs, params.sort)) {
      bad(`No se puede ordenar por la columna "${params.sort}"`);
    }
    sort = { column: params.sort, order: params.order ?? 'asc' };
  }
  return { filters, sort };
}

/** ¿Hay filtros por columna u orden? (si no, el listado va por su SQL). */
export function isColumnQueryActive(query: ColumnQuery): boolean {
  return query.filters.size > 0 || query.sort !== null;
}

/** Columna pedida a `/facets`; debe existir en la tabla. */
export function requireFacetColumn<T>(
  column: string | undefined,
  defs: ColumnDefs<T>,
): string {
  if (!column) bad('Falta el parámetro "column"');
  if (!Object.prototype.hasOwnProperty.call(defs, column)) {
    bad(`La columna "${column}" no tiene filtro`);
  }
  return column;
}

// ── Evaluación ──────────────────────────────────────────────────────────

function matches<T>(def: ColumnDef<T>, filter: ColumnFilter, row: T): boolean {
  const key = keyOf(def.type, def.value(row));
  if (filter.kind === 'values') {
    const hit = filter.values.has(key as FacetKey);
    return filter.include ? hit : !hit;
  }
  if (filter.empty) return key === null;
  if (key === null) return false;
  if (filter.min !== null && key < filter.min) return false;
  if (filter.max !== null && key > filter.max) return false;
  return true;
}

function compareKeys(
  type: ColumnType,
  a: string | number,
  b: string | number,
): number {
  if (type === 'number') return (a as number) - (b as number);
  if (type === 'date') return a < b ? -1 : a > b ? 1 : 0;
  return COLLATOR.compare(a as string, b as string);
}

/**
 * Aplica los filtros por columna (salvo `exclude`, que es la columna de la
 * que se arma la faceta: Excel muestra sus valores con los DEMÁS filtros) y
 * el orden. Las vacías quedan al final en ambos sentidos.
 */
export function applyColumnQuery<T>(
  rows: T[],
  // NoInfer: el tipo de fila sale de `rows` (las columnas pueden leer menos)
  defs: NoInfer<ColumnDefs<T>>,
  query: ColumnQuery,
  options: { exclude?: string; sort?: boolean } = {},
): T[] {
  const active = [...query.filters.entries()].filter(
    ([column]) => column !== options.exclude,
  );
  let out = active.length
    ? rows.filter((row) =>
        active.every(([column, filter]) => matches(defs[column], filter, row)),
      )
    : rows;
  if (query.sort && options.sort !== false) {
    const def = defs[query.sort.column];
    const direction = query.sort.order === 'desc' ? -1 : 1;
    const keyed = out.map((row) => ({
      row,
      key: keyOf(def.type, def.value(row)),
    }));
    keyed.sort((x, y) => {
      if (x.key === null || y.key === null) {
        return x.key === y.key ? 0 : x.key === null ? 1 : -1;
      }
      return direction * compareKeys(def.type, x.key, y.key);
    });
    out = keyed.map((k) => k.row);
  }
  return out;
}

/** Valores distintos (texto) o mínimo/máximo (número/fecha) de la columna. */
export function columnFacet<T>(
  rows: T[],
  defs: NoInfer<ColumnDefs<T>>,
  column: string,
  search?: string,
): ColumnFacet {
  const def = defs[column];
  if (def.type === 'text') {
    const counts = new Map<FacetKey, number>();
    for (const row of rows) {
      const key = textKey(def.value(row));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const term = search?.trim() ? fold(search.trim()) : null;
    const values = [...counts.entries()]
      .filter(([key]) => !term || (key !== null && fold(key).includes(term)))
      .map(([value, count]) => ({ value, count }))
      .sort(
        (a, b) =>
          b.count - a.count ||
          (a.value === null ? 1 : b.value === null ? -1 : 0) ||
          COLLATOR.compare(a.value ?? '', b.value ?? ''),
      );
    return {
      column,
      type: 'text',
      values: values.slice(0, FACET_LIMIT),
      truncated: values.length > FACET_LIMIT,
      total: rows.length,
    };
  }
  let min: number | string | null = null;
  let max: number | string | null = null;
  let count = 0;
  for (const row of rows) {
    const key = keyOf(def.type, def.value(row));
    if (key === null) continue;
    count += 1;
    if (min === null || key < min) min = key;
    if (max === null || key > max) max = key;
  }
  return {
    column,
    type: def.type,
    min,
    max,
    count,
    empty: rows.length - count,
    total: rows.length,
  };
}

/**
 * `/facets` completo sobre las filas ya cargadas: valida la columna, aplica
 * los DEMÁS filtros por columna y arma su faceta.
 */
export function facetOf<T>(
  rows: T[],
  defs: NoInfer<ColumnDefs<T>>,
  params: ColumnQueryParams & { column?: string; facet_search?: string },
): ColumnFacet {
  const column = requireFacetColumn(params.column, defs);
  const query = parseColumnQuery(params, defs);
  return columnFacet(
    applyColumnQuery(rows, defs, query, { exclude: column, sort: false }),
    defs,
    column,
    params.facet_search,
  );
}

/** Página en memoria con el mismo `meta` que los listados paginados en SQL. */
export function paginateRows<T>(rows: T[], page = 1, limit = 20) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    data: rows.slice((page - 1) * limit, page * limit),
    meta: {
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}
