/**
 * DTOs canónicos de la integración SAP (Fase INT-4): lo que el mapper
 * produce y el staging persiste. Fechas como string ISO (crudas de SAP);
 * montos como number.
 *
 * Los 3 UDF de compras vienen NORMALIZADOS: el placeholder del ERP
 * ("SELECCIONAR", vacío o null) se colapsa a `null` = SIN DATO. El valor
 * original siempre queda en el `raw` del staging.
 */

export interface SapDocumentLineDto {
  lineNum: number | null;
  itemCode: string | null;
  itemDescription: string | null;
  lineTotal: number | null;
  currency: string | null;
  /** U_Clas_gts (clasificación de gasto). null = sin capturar en el ERP. */
  clasGts: string | null;
  /** U_Imp_ahorro (importe de ahorro). null = sin capturar; 0 es un valor real. */
  impAhorro: number | null;
  /** U_Proc_Comp (proceso de compra). null = sin capturar en el ERP. */
  procComp: string | null;
}

interface SapDocumentBaseDto {
  docEntry: number;
  docNum: number | null;
  docDate: string | null;
  docDueDate: string | null;
  updateDate: string | null;
  documentStatus: string | null;
  /** `Cancelled` de SAP (tYES/tNO): true = cancelada (sprint 2026-09-22, A6). */
  cancelled: boolean | null;
  cancelStatus: string | null;
  authorizationStatus: string | null;
  confirmed: boolean | null;
  closingDate: string | null;
  comments: string | null;
  lines: SapDocumentLineDto[];
  /** Total de líneas del documento. */
  linesTotal: number;
  /** Líneas con U_Clas_gts REAL (≠ placeholder). */
  linesClassified: number;
  /** Suma de U_Imp_ahorro reales; null = ninguna línea lo trae (T10). */
  ahorroTotal: number | null;
}

export interface SapPurchaseOrderDto extends SapDocumentBaseDto {
  cardCode: string | null;
  cardName: string | null;
  docTotal: number | null;
  currency: string | null;
}

export interface SapPurchaseRequestDto extends SapDocumentBaseDto {
  requester: string | null;
  requesterName: string | null;
  requiredDate: string | null;
  /** Suma de LineTotal (el SL no permite $select=DocTotal en esta entidad). */
  docTotal: number | null;
  /** Moneda de la primera línea; null si el doc no tiene líneas. */
  currency: string | null;
}

/**
 * Proveedor (BusinessPartner cSupplier) canónico. El espejo al catálogo del
 * dominio escribe SOLO estos básicos; puntuación/bloqueo son de ABENT.
 */
export interface SapBusinessPartnerDto {
  cardCode: string;
  cardName: string | null;
  cardType: string | null;
  federalTaxId: string | null;
  email: string | null;
  phone1: string | null;
  phone2: string | null;
  contactPerson: string | null;
  website: string | null;
  /** Moneda del BP; '##' = multimoneda (valor literal de SAP B1). */
  currency: string | null;
  sapValid: boolean | null;
  sapFrozen: boolean | null;
  updateDate: string | null;
}

// ── Cola de autorización (B5) ────────────────────────────────────────────────

export interface SapApprovalLineDto {
  stageCode: number | null;
  stageName: string | null;
  userId: number | null;
  userName: string | null;
  status: string | null;
  updateDate: string | null;
}

/** Catálogos de SAP que enriquecen cada solicitud de autorización. */
export interface SapApprovalCatalogs {
  /** Drafts.DocEntry → borrador (slim). */
  drafts: Map<number, SapRawDraftSlimLike>;
  /** Users.InternalKey → UserName. */
  users: Map<number, string>;
  /** ApprovalStages.Code → Name. */
  stages: Map<number, string>;
  /** ApprovalTemplates.Code → Name. */
  templates: Map<number, string>;
}

export interface SapRawDraftSlimLike {
  DocNum?: unknown;
  DocDate?: unknown;
  DocTotal?: unknown;
  DocCurrency?: unknown;
  CardName?: unknown;
  RequesterName?: unknown;
  DocObjectCode?: unknown;
}

export interface SapApprovalRequestDto {
  code: number;
  approvalTemplateId: number | null;
  templateName: string | null;
  objectType: string | null;
  isDraft: boolean | null;
  draftEntry: number | null;
  draftType: string | null;
  objectEntry: number | null;
  status: string | null;
  remarks: string | null;
  currentStage: number | null;
  currentStageName: string | null;
  originatorId: number | null;
  originatorName: string | null;
  creationDate: string | null;
  docNum: number | null;
  docDate: string | null;
  docTotal: number | null;
  currency: string | null;
  cardName: string | null;
  requesterName: string | null;
  approvers: SapApprovalLineDto[];
}
