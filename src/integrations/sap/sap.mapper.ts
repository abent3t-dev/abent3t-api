import { createHash } from 'node:crypto';
import {
  SapDocumentLineDto,
  SapPurchaseOrderDto,
  SapPurchaseRequestDto,
} from './dto/sap-document.dto';
import {
  SapRawDocumentLine,
  SapRawPurchaseOrder,
  SapRawPurchaseRequest,
} from './dto/sap-raw.types';
import { SapMappingError } from './sap.errors';

/**
 * Mapper puro crudo → canónico de la integración SAP (Fase INT-4). Sin I/O,
 * sin Nest: funciones deterministas testeables en aislamiento (mismo
 * criterio que el mapper de Maximo).
 *
 * Subir la versión cuando cambie CUALQUIER regla de mapeo: el staging la
 * persiste por fila y permite re-mapear desde `raw` sin re-descargar.
 */
export const SAP_MAPPER_VERSION = '1.0.0';

/**
 * Placeholder de las listas de valores de los UDF: el ERP lo trae de fábrica
 * cuando nadie ha capturado el campo. Cuenta como SIN DATO (nunca se muestra
 * como clasificación real) — validado con Henry: la captura real arrancó el
 * 2026-09-15 y es incremental.
 */
const UDF_PLACEHOLDER = 'SELECCIONAR';

export function toSapPurchaseOrder(raw: unknown): SapPurchaseOrderDto {
  const doc = asRecord(raw, 'PurchaseOrders') as SapRawPurchaseOrder;
  const docEntry = requireDocEntry(doc.DocEntry);
  const lines = mapLines(doc.DocumentLines);
  return {
    docEntry,
    docNum: toIntOrNull(doc.DocNum),
    docDate: toIsoOrNull(doc.DocDate),
    docDueDate: toIsoOrNull(doc.DocDueDate),
    updateDate: toIsoOrNull(doc.UpdateDate),
    documentStatus: toTextOrNull(doc.DocumentStatus),
    comments: toTextOrNull(doc.Comments),
    cardCode: toTextOrNull(doc.CardCode),
    cardName: toTextOrNull(doc.CardName),
    docTotal: toNumberOrNull(doc.DocTotal),
    currency: toTextOrNull(doc.DocCurrency),
    lines,
    ...lineAggregates(lines),
  };
}

export function toSapPurchaseRequest(raw: unknown): SapPurchaseRequestDto {
  const doc = asRecord(raw, 'PurchaseRequests') as SapRawPurchaseRequest;
  const docEntry = requireDocEntry(doc.DocEntry);
  const lines = mapLines(doc.DocumentLines);
  return {
    docEntry,
    docNum: toIntOrNull(doc.DocNum),
    docDate: toIsoOrNull(doc.DocDate),
    docDueDate: toIsoOrNull(doc.DocDueDate),
    requiredDate: toIsoOrNull(doc.RequriedDate),
    updateDate: toIsoOrNull(doc.UpdateDate),
    documentStatus: toTextOrNull(doc.DocumentStatus),
    comments: toTextOrNull(doc.Comments),
    requester: toTextOrNull(doc.Requester),
    requesterName: toTextOrNull(doc.RequesterName),
    // El SL rechaza $select=DocTotal en PurchaseRequests: se suma LineTotal.
    docTotal: sumLineTotals(lines),
    currency: lines.length > 0 ? lines[0].currency : null,
    lines,
    ...lineAggregates(lines),
  };
}

/**
 * Hash estable del documento crudo (sha256 del JSON tal cual llegó) para
 * detección de cambios en staging: `UpdateDate` de SAP tiene granularidad
 * de día y no distingue dos ediciones el mismo día.
 */
export function sapRawHash(raw: unknown): string {
  return createHash('sha256').update(JSON.stringify(raw)).digest('hex');
}

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

function mapLines(rawLines: unknown): SapDocumentLineDto[] {
  if (!Array.isArray(rawLines)) return [];
  return rawLines.map((entry) => {
    const line = (isRecord(entry) ? entry : {}) as SapRawDocumentLine;
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

function lineAggregates(lines: SapDocumentLineDto[]): {
  linesTotal: number;
  linesClassified: number;
  ahorroTotal: number | null;
} {
  const linesClassified = lines.filter((l) => l.clasGts !== null).length;
  const withAhorro = lines.filter((l) => l.impAhorro !== null);
  const ahorroTotal =
    withAhorro.length === 0
      ? null // T10: sin capturas reales NO se inventa un 0
      : round2(withAhorro.reduce((sum, l) => sum + (l.impAhorro ?? 0), 0));
  return { linesTotal: lines.length, linesClassified, ahorroTotal };
}

function sumLineTotals(lines: SapDocumentLineDto[]): number | null {
  const withTotal = lines.filter((l) => l.lineTotal !== null);
  if (withTotal.length === 0) return null;
  return round2(withTotal.reduce((sum, l) => sum + (l.lineTotal ?? 0), 0));
}

/** UDF de texto: null / vacío / placeholder "SELECCIONAR" → null (sin dato). */
function normalizeUdfText(value: unknown): string | null {
  const text = toTextOrNull(value);
  if (text === null) return null;
  return text.toUpperCase() === UDF_PLACEHOLDER ? null : text;
}

function requireDocEntry(value: unknown): number {
  const parsed = toIntOrNull(value);
  if (parsed === null) {
    throw new SapMappingError('DocEntry ausente o no numérico', 'DocEntry');
  }
  return parsed;
}

function asRecord(value: unknown, entity: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SapMappingError(
      `el documento de ${entity} no es un objeto`,
      'documento',
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : value;
}

function round2(value: number): number {
  // Épsilon contra el clásico 1.005*100 = 100.4999… del punto flotante.
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
