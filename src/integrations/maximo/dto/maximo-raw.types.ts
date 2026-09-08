/**
 * Formas CRUDAS de las respuestas de IBM Maximo (validadas en producción
 * 12-13 ago 2026, evidencia en `maximo-validation/` y `__fixtures__/`).
 *
 * Existen TRES formas de JSON para las mismas Object Structures:
 *
 * 1. REST legacy "anidado" (`/maxrest/rest/os/<OS>?_format=json`):
 *    `{ QueryAB_COMPRASResponse: { rsStart, rsCount, rsTotal, AB_COMPRASSet: { PO: [
 *       { rowstamp, Attributes: { PONUM: { content: 'PO1' } }, RelatedMbos: { POLINE: [ … ] } } ] } } }`
 * 2. REST legacy "compacto" (`…&_compact=1`): mismo sobre, pero cada registro es
 *    plano: `{ rowstamp, PONUM: 'PO1', POLINE: [ … ] }`.
 * 3. OSLC (`/maximo/oslc/os/<OS>?oslc.select=*&lean=1`): `{ member: [ { ponum: 'PO1',
 *    poline: [ … ], _rowstamp, href, localref, poline_collectionref } ], href, responseInfo }`.
 *
 * Reglas comunes: los campos SIN dato se OMITEN (no llegan como null); el
 * literal `"~null~"` equivale a null; los nombres de campo son UPPERCASE en
 * REST y lowercase en OSLC. El mapper normaliza las tres formas a
 * `MaximoCanonicalRecord` antes de producir los DTOs internos.
 */

export type MaximoRawScalar = string | number | boolean | null;

/** Atributo del REST legacy anidado. */
export interface MaximoLegacyAttribute {
  content?: MaximoRawScalar;
  /** Marca el atributo que identifica al recurso (p. ej. PERSONUID). */
  resourceid?: boolean;
}

/** Registro del REST legacy anidado (forma 1). */
export interface MaximoLegacyNestedRecord {
  rowstamp?: string;
  Attributes?: Record<string, MaximoLegacyAttribute>;
  RelatedMbos?: Record<string, MaximoLegacyNestedRecord[]>;
}

/** Registro del REST legacy compacto (forma 2): escalares + hijos como arrays. */
export type MaximoLegacyCompactRecord = {
  rowstamp?: string;
} & Record<string, MaximoRawScalar | MaximoLegacyCompactRecord[] | undefined>;

export type MaximoLegacyRecord =
  | MaximoLegacyNestedRecord
  | MaximoLegacyCompactRecord;

/** Cuerpo de `Query<OS>Response`. El set contiene la raíz (PO, PR o PURCHVIEW). */
export interface MaximoLegacyQueryResponse {
  rsStart?: number;
  rsCount?: number;
  /** Solo llega en listados sin filtro; en filtros por igualdad se omite. */
  rsTotal?: number;
  [setKey: string]: unknown;
}

/** Sobre completo del REST legacy: `{ QueryAB_COMPRASResponse: … }`. */
export type MaximoLegacyEnvelope = Record<string, MaximoLegacyQueryResponse>;

/** Registro OSLC (forma 3, `lean=1`): claves lowercase + metadatos `href`/`localref`. */
export type MaximoOslcRecord = {
  _rowstamp?: string;
  href?: string;
  localref?: string;
} & Record<string, unknown>;

export interface MaximoOslcResponseInfo {
  href?: string;
  /** Presente cuando hay más páginas (`oslc.pageSize`). NO validado en prod. */
  nextPage?: { href?: string };
  /** Presente con `collectioncount=1`. NO validado en prod. */
  totalCount?: number;
  pagenum?: number;
}

export interface MaximoOslcEnvelope {
  member?: MaximoOslcRecord[];
  href?: string;
  responseInfo?: MaximoOslcResponseInfo;
}

/** Error OSLC (HTTP 400): `{ Error: { reasonCode: 'BMXAA8781E', message, statusCode: '400' } }`. */
export interface MaximoOslcErrorEnvelope {
  Error?: {
    reasonCode?: string;
    message?: string;
    statusCode?: string;
    extendedError?: { moreInfo?: { href?: string } };
  };
}

/** Object Structures de Maximo consumidas por ABENT (solo lectura). */
export type MaximoObjectStructure = 'AB_COMPRAS' | 'AB_CONTRATOS';

/** API usada para una lectura concreta. */
export type MaximoApi = 'legacy' | 'oslc';

/**
 * Registro normalizado: claves UPPERCASE, escalares desenvueltos (`content`),
 * `"~null~"` → null, hijos como arrays de registros canónicos, `rowstamp` /
 * `_rowstamp` → `ROWSTAMP`. Metadatos OSLC (`href`, `localref`,
 * `*_collectionref`) descartados.
 */
export interface MaximoCanonicalRecord {
  [key: string]: MaximoRawScalar | MaximoCanonicalRecord[] | undefined;
}
