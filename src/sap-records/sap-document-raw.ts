import { SapDocumentLineView } from './sap-records.types';

/**
 * Fase INT-4 — Derivación PURA de las líneas del documento desde el `raw`
 * jsonb del staging (mismo precedente que la derivación de líneas de
 * contrato en el módulo de lectura de Int-5: el dominio no importa la capa
 * externa, así que la regla de normalización de los 3 UDF se REPLICA aquí
 * con comentario de origen — cualquier cambio debe hacerse en ambos lados).
 *
 * Regla replicada del mapper de la capa externa: el placeholder de lista de
 * valores del ERP ("SELECCIONAR", vacío o null) cuenta como SIN DATO → null.
 */
const UDF_PLACEHOLDER = 'SELECCIONAR';

interface RawLine {
  LineNum?: unknown;
  ItemCode?: unknown;
  ItemDescription?: unknown;
  LineTotal?: unknown;
  Currency?: unknown;
  U_Clas_gts?: unknown;
  U_Imp_ahorro?: unknown;
  U_Proc_Comp?: unknown;
}

/** Deriva las líneas de un documento crudo del staging (mejor esfuerzo). */
export function deriveSapLines(raw: unknown): SapDocumentLineView[] {
  const doc = raw as { DocumentLines?: unknown } | null;
  const rawLines = doc?.DocumentLines;
  if (!Array.isArray(rawLines)) return [];
  return rawLines.map((entry) => {
    const line = (entry ?? {}) as RawLine;
    return {
      lineNum: toIntOrNull(line.LineNum),
      itemCode: toTextOrNull(line.ItemCode),
      itemDescription: toTextOrNull(line.ItemDescription),
      lineTotal: toNumberOrNull(line.LineTotal),
      currency: toTextOrNull(line.Currency),
      clasGts: normalizeUdfText(line.U_Clas_gts),
      impAhorro: toNumberOrNull(line.U_Imp_ahorro),
      procComp: normalizeUdfText(line.U_Proc_Comp),
    };
  });
}

function normalizeUdfText(value: unknown): string | null {
  const text = toTextOrNull(value);
  if (text === null) return null;
  return text.toUpperCase() === UDF_PLACEHOLDER ? null : text;
}

function toTextOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toIntOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
