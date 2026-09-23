import { SapDocumentLineView } from './sap-records.types';

/**
 * Fase INT-4 — Derivación PURA de las líneas del documento desde el `raw`
 * jsonb del staging (mismo precedente que la derivación de líneas de
 * contrato en el módulo de lectura de Int-5: el dominio no importa la capa
 * externa, así que las reglas de normalización se REPLICAN aquí con
 * comentario de origen — cualquier cambio debe hacerse en ambos lados).
 *
 * Reglas replicadas del mapper de la capa externa:
 * - El placeholder de lista de valores del ERP ("SELECCIONAR", vacío o
 *   null) cuenta como SIN DATO → null.
 * - Importes en la moneda del DOCUMENTO: `LineTotal`/`GrossTotal` vienen
 *   siempre en MXN (moneda local); en un documento en USD/EUR se usan
 *   `RowTotalFC`/`GrossTotalFC`. Sin DocCurrency (solicitudes sincronizadas
 *   antes del mapper 1.2.0) el documento es local si todas sus líneas
 *   traen RowTotalFC = 0.
 */
const UDF_PLACEHOLDER = 'SELECCIONAR';
const LOCAL_CURRENCY = 'MXN';

interface RawLine {
  LineNum?: unknown;
  ItemCode?: unknown;
  ItemDescription?: unknown;
  LineTotal?: unknown;
  RowTotalFC?: unknown;
  GrossTotal?: unknown;
  GrossTotalFC?: unknown;
  Quantity?: unknown;
  RemainingOpenQuantity?: unknown;
  LineStatus?: unknown;
  U_Clas_gts?: unknown;
  U_Imp_ahorro?: unknown;
  U_Proc_Comp?: unknown;
}

/** Deriva las líneas de un documento crudo del staging (mejor esfuerzo). */
export function deriveSapLines(raw: unknown): SapDocumentLineView[] {
  const doc = raw as { DocumentLines?: unknown; DocCurrency?: unknown } | null;
  const rawLines = doc?.DocumentLines;
  if (!Array.isArray(rawLines)) return [];
  const lines = rawLines.map((entry) => (entry ?? {}) as RawLine);
  const currency =
    toTextOrNull(doc?.DocCurrency) ??
    (lines.length > 0 &&
    lines.every((line) => toNumberOrNull(line.RowTotalFC) === 0)
      ? LOCAL_CURRENCY
      : null);
  const foreign = currency !== null && currency !== LOCAL_CURRENCY;
  return lines.map((line) => {
    const quantity = toNumberOrNull(line.Quantity);
    const openQuantity = toNumberOrNull(line.RemainingOpenQuantity);
    const gross = toNumberOrNull(foreign ? line.GrossTotalFC : line.GrossTotal);
    const lineStatus =
      line.LineStatus === 'bost_Open'
        ? 'open'
        : line.LineStatus === 'bost_Close'
          ? 'close'
          : null;
    return {
      lineNum: toIntOrNull(line.LineNum),
      itemCode: toTextOrNull(line.ItemCode),
      itemDescription: toTextOrNull(line.ItemDescription),
      lineTotal: toNumberOrNull(foreign ? line.RowTotalFC : line.LineTotal),
      currency,
      quantity,
      openQuantity,
      lineStatus,
      openTotal: lineOpenTotal(lineStatus, gross, quantity, openQuantity),
      clasGts: normalizeUdfText(line.U_Clas_gts),
      impAhorro: toNumberOrNull(line.U_Imp_ahorro),
      procComp: normalizeUdfText(line.U_Proc_Comp),
    };
  });
}

/** Pendiente de la línea con IVA (misma proporción que el saldo de la OC). */
function lineOpenTotal(
  status: 'open' | 'close' | null,
  gross: number | null,
  quantity: number | null,
  openQuantity: number | null,
): number | null {
  if (status === 'close') return 0;
  if (status === null || gross === null || quantity === null) return null;
  if (quantity <= 0 || openQuantity === null) return null;
  const ratio = Math.min(Math.max(openQuantity, 0), quantity) / quantity;
  return Math.round(gross * ratio * 100) / 100;
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
