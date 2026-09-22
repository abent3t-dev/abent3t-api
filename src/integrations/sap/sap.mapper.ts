import { createHash } from 'node:crypto';
import {
  SapApprovalCatalogs,
  SapApprovalLineDto,
  SapApprovalRequestDto,
  SapBusinessPartnerDto,
  SapDocumentLineDto,
  SapPurchaseOrderDto,
  SapPurchaseRequestDto,
} from './dto/sap-document.dto';
import {
  SapRawApprovalLine,
  SapRawApprovalRequest,
  SapRawBusinessPartner,
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
// 1.1.0: Cancelled/AuthorizationStatus/ClosingDate (A6); 1.1.1: approvers en
// snake_case (B5). Un cambio de versión fuerza el re-mapeo aunque el raw no
// cambie (ver SapStagingService), así que basta un sync full tras desplegar.
export const SAP_MAPPER_VERSION = '1.1.1';

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
    ...cancelFields(doc),
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
    ...cancelFields(doc),
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

export function toSapBusinessPartner(raw: unknown): SapBusinessPartnerDto {
  const bp = asRecord(raw, 'BusinessPartners') as SapRawBusinessPartner;
  const cardCode = toTextOrNull(bp.CardCode);
  if (cardCode === null) {
    throw new SapMappingError('CardCode ausente o vacío', 'CardCode');
  }
  return {
    cardCode,
    cardName: toTextOrNull(bp.CardName),
    cardType: toTextOrNull(bp.CardType),
    federalTaxId: toTextOrNull(bp.FederalTaxID),
    email: toTextOrNull(bp.EmailAddress),
    phone1: toTextOrNull(bp.Phone1),
    phone2: toTextOrNull(bp.Phone2),
    contactPerson: toTextOrNull(bp.ContactPerson),
    website: toTextOrNull(bp.Website),
    currency: toTextOrNull(bp.Currency),
    sapValid: toSapBoolOrNull(bp.Valid),
    sapFrozen: toSapBoolOrNull(bp.Frozen),
    updateDate: toIsoOrNull(bp.UpdateDate),
  };
}

/**
 * Solicitud de autorización (B5) enriquecida con catálogos: nombres de
 * usuario/etapa/plantilla y datos del borrador. Sin catálogo → null (nunca
 * se inventa). `raw` que se persiste = { request, draft } para que el hash
 * detecte cambios de cualquiera de los dos.
 */
export function toSapApprovalRequest(
  raw: unknown,
  catalogs: SapApprovalCatalogs,
): SapApprovalRequestDto {
  const req = asRecord(raw, 'ApprovalRequests') as SapRawApprovalRequest;
  const code = toIntOrNull(req.Code);
  if (code === null) {
    throw new SapMappingError('Code ausente o no numérico', 'Code');
  }
  const draftEntry = toIntOrNull(req.DraftEntry);
  const draft =
    draftEntry === null ? undefined : catalogs.drafts.get(draftEntry);
  const templateId = toIntOrNull(req.ApprovalTemplatesID);
  const stage = toIntOrNull(req.CurrentStage);
  const originatorId = toIntOrNull(req.OriginatorID);
  const lines = Array.isArray(req.ApprovalRequestLines)
    ? req.ApprovalRequestLines
    : [];
  const approvers: SapApprovalLineDto[] = lines.map((entry) => {
    const line = (isRecord(entry) ? entry : {}) as SapRawApprovalLine;
    const stageCode = toIntOrNull(line.StageCode);
    const userId = toIntOrNull(line.UserID);
    return {
      stageCode,
      stageName:
        stageCode === null ? null : (catalogs.stages.get(stageCode) ?? null),
      userId,
      userName: userId === null ? null : (catalogs.users.get(userId) ?? null),
      status: toTextOrNull(line.Status),
      updateDate: toIsoOrNull(line.UpdateDate),
    };
  });
  return {
    code,
    approvalTemplateId: templateId,
    templateName:
      templateId === null ? null : (catalogs.templates.get(templateId) ?? null),
    objectType: toTextOrNull(req.ObjectType),
    isDraft: toYnOrNull(req.IsDraft),
    draftEntry,
    draftType: toTextOrNull(req.DraftType),
    objectEntry: toIntOrNull(req.ObjectEntry),
    status: toTextOrNull(req.Status),
    remarks: toTextOrNull(req.Remarks),
    currentStage: stage,
    currentStageName:
      stage === null ? null : (catalogs.stages.get(stage) ?? null),
    originatorId,
    originatorName:
      originatorId === null ? null : (catalogs.users.get(originatorId) ?? null),
    creationDate: toIsoOrNull(req.CreationDate),
    docNum: toIntOrNull(draft?.DocNum),
    docDate: toIsoOrNull(draft?.DocDate),
    docTotal: toNumberOrNull(draft?.DocTotal),
    currency: toTextOrNull(draft?.DocCurrency),
    cardName: toTextOrNull(draft?.CardName),
    requesterName: toTextOrNull(draft?.RequesterName),
    approvers,
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

/**
 * Campos de cancelación/autorización/cierre (A6): SAP no distingue una
 * cancelada por DocumentStatus (llega bost_Close) sino por `Cancelled`.
 */
function cancelFields(doc: {
  Cancelled?: unknown;
  CancelStatus?: unknown;
  AuthorizationStatus?: unknown;
  Confirmed?: unknown;
  ClosingDate?: unknown;
}): {
  cancelled: boolean | null;
  cancelStatus: string | null;
  authorizationStatus: string | null;
  confirmed: boolean | null;
  closingDate: string | null;
} {
  return {
    cancelled: toSapBoolOrNull(doc.Cancelled),
    cancelStatus: toTextOrNull(doc.CancelStatus),
    authorizationStatus: toTextOrNull(doc.AuthorizationStatus),
    confirmed: toSapBoolOrNull(doc.Confirmed),
    closingDate: toIsoOrNull(doc.ClosingDate),
  };
}

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

/** Banderas 'Y' / 'N' (IsDraft). Cualquier otra cosa → null. */
function toYnOrNull(value: unknown): boolean | null {
  if (value === 'Y') return true;
  if (value === 'N') return false;
  return null;
}

/** Booleanos de SAP B1: 'tYES' / 'tNO'. Cualquier otra cosa → null. */
function toSapBoolOrNull(value: unknown): boolean | null {
  if (value === 'tYES') return true;
  if (value === 'tNO') return false;
  return null;
}

function round2(value: number): number {
  // Épsilon contra el clásico 1.005*100 = 100.4999… del punto flotante.
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
