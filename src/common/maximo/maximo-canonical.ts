/**
 * K3.7 (2026-10-05): canonizador PURO de los registros crudos de Maximo.
 *
 * Vive en `common` para que lo usen el mapper de la integración (vía su
 * envoltorio `toCanonical`, que sí lanza) y quien lee el `raw` ya guardado en
 * staging (`maximo-records`), que no puede importar del módulo de
 * integración. Por eso tiene su propio tipo y no importa nada de
 * `integrations`.
 *
 * Acepta las tres formas de Maximo y regresa siempre la misma:
 *   1. legacy anidado (`rowstamp` + `Attributes` / `RelatedMbos`): el `raw`
 *      que guarda prod, porque el listado no pide `_compact`;
 *   2. legacy compacto (escalares + hijos como arreglos);
 *   3. OSLC lean (claves en minúsculas, `_rowstamp`, `href`…).
 * Claves en MAYÚSCULAS, escalares desenvueltos (`{ content }`, `"~null~"` →
 * null), hijos como arreglos canónicos, `rowstamp` / `_rowstamp` →
 * `ROWSTAMP` y sin metadatos OSLC (`href`, `localref`, `*_collectionref`).
 *
 * Sin I/O ni estado. Una entrada que no es objeto da null, nunca una
 * excepción: el raw es de Maximo, no nuestro.
 */

export type CanonicalMaximoScalar = string | number | boolean | null;

/** Registro canónico (misma forma que espera el mapper de la integración). */
export interface CanonicalMaximoRecord {
  [key: string]: CanonicalMaximoScalar | CanonicalMaximoRecord[] | undefined;
}

const NULL_TOKEN = '~null~';
const OSLC_META_KEYS = new Set(['href', 'localref']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Desenvuelve `{ content: X }`, `"~null~"` y tipos no escalares → null. */
function unwrapScalar(value: unknown): CanonicalMaximoScalar {
  if (isPlainObject(value)) {
    return 'content' in value ? unwrapScalar(value.content) : null;
  }
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value === NULL_TOKEN ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

function canonicalChildren(value: unknown[]): CanonicalMaximoRecord[] {
  return value.filter(isPlainObject).map(canonicalObject);
}

function canonicalObject(raw: Record<string, unknown>): CanonicalMaximoRecord {
  const out: CanonicalMaximoRecord = {};

  // Forma 1: legacy anidado (Attributes / RelatedMbos)
  const attrs = raw.Attributes;
  const related = raw.RelatedMbos;
  if (isPlainObject(attrs) || isPlainObject(related)) {
    if (typeof raw.rowstamp === 'string') out.ROWSTAMP = raw.rowstamp;
    if (isPlainObject(attrs)) {
      for (const [key, value] of Object.entries(attrs)) {
        out[key.toUpperCase()] = unwrapScalar(value);
      }
    }
    if (isPlainObject(related)) {
      for (const [key, value] of Object.entries(related)) {
        if (Array.isArray(value)) {
          out[key.toUpperCase()] = canonicalChildren(value);
        }
      }
    }
    return out;
  }

  // Formas 2 (legacy compacto) y 3 (OSLC lean)
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    if (OSLC_META_KEYS.has(lower) || lower.endsWith('_collectionref')) continue;
    const name =
      lower === '_rowstamp' || lower === 'rowstamp'
        ? 'ROWSTAMP'
        : key.toUpperCase();
    if (Array.isArray(value)) {
      out[name] = canonicalChildren(value);
      continue;
    }
    out[name] = unwrapScalar(value);
  }
  return out;
}

/**
 * Normaliza un registro de cualquiera de las tres formas. null si la entrada
 * no es un objeto (arreglo, escalar, null o undefined).
 */
export function canonicalize(raw: unknown): CanonicalMaximoRecord | null {
  return isPlainObject(raw) ? canonicalObject(raw) : null;
}
