/**
 * Formas CRUDAS del Service Layer de SAP B1 (Fase INT-4), tal como llegan
 * de `GET /PurchaseOrders` y `GET /PurchaseRequests` con el `$select`
 * validado en vivo contra PRD_ABENT (2026-09-17). Campos `unknown` a
 * propósito: el mapper valida tipo por tipo (SAP puede devolver null en
 * casi todo).
 *
 * Notas de la validación:
 * - `$expand=DocumentLines` da HTTP 400 en esta versión (no es navigation
 *   property): las líneas llegan COMPLETAS vía `$select=...,DocumentLines`
 *   y no se pueden proyectar — por eso la línea cruda trae ~130 campos y
 *   aquí solo se tipan los que el mapper lee.
 * - `PurchaseRequests` rechaza `$select` de CardCode/CardName/DocTotal
 *   (HTTP 400): las solicitudes usan Requester/RequesterName y el total se
 *   calcula sumando `LineTotal`.
 * - `RequriedDate` está escrito así (sic) en el esquema de SAP.
 */

export interface SapRawDocumentLine {
  LineNum?: unknown;
  ItemCode?: unknown;
  ItemDescription?: unknown;
  LineTotal?: unknown;
  Currency?: unknown;
  U_Clas_gts?: unknown;
  U_Imp_ahorro?: unknown;
  U_Proc_Comp?: unknown;
}

interface SapRawDocumentBase {
  DocEntry?: unknown;
  DocNum?: unknown;
  DocDate?: unknown;
  DocDueDate?: unknown;
  UpdateDate?: unknown;
  DocumentStatus?: unknown;
  Comments?: unknown;
  DocumentLines?: unknown;
  /** tYES/tNO — una cancelada llega con DocumentStatus=bost_Close. */
  Cancelled?: unknown;
  CancelStatus?: unknown;
  AuthorizationStatus?: unknown;
  Confirmed?: unknown;
  ClosingDate?: unknown;
}

export interface SapRawPurchaseOrder extends SapRawDocumentBase {
  CardCode?: unknown;
  CardName?: unknown;
  DocTotal?: unknown;
  DocCurrency?: unknown;
}

export interface SapRawPurchaseRequest extends SapRawDocumentBase {
  Requester?: unknown;
  RequesterName?: unknown;
  RequriedDate?: unknown; // sic
}

export interface SapRawBusinessPartner {
  CardCode?: unknown;
  CardName?: unknown;
  CardType?: unknown;
  FederalTaxID?: unknown;
  EmailAddress?: unknown;
  Phone1?: unknown;
  Phone2?: unknown;
  ContactPerson?: unknown;
  Website?: unknown;
  Currency?: unknown; // '##' = multimoneda en SAP B1
  Valid?: unknown; // 'tYES' | 'tNO'
  Frozen?: unknown; // 'tYES' | 'tNO'
  UpdateDate?: unknown;
}

/** Sobre estándar de colección OData del Service Layer. */
export interface SapRawCollection {
  value?: unknown;
}

// ── Cola de autorización (sprint 2026-09-22, B5) ─────────────────────────────
// Validado en vivo contra PRD_ABENT (2026-09-22): ApprovalRequests (548),
// Drafts (581, `$select` sin DocumentLines funciona), Users (66) y
// ApprovalStages (20) son legibles con nuestro usuario. ApprovalRequests NO
// trae UpdateDate → el sync de este target es siempre full (barato).

export interface SapRawApprovalLine {
  StageCode?: unknown;
  UserID?: unknown;
  Status?: unknown; // ardPending | ardApproved | ardNotApproved
  Remarks?: unknown;
  UpdateDate?: unknown;
  UpdateTime?: unknown;
}

export interface SapRawApprovalRequest {
  Code?: unknown;
  ApprovalTemplatesID?: unknown;
  ObjectType?: unknown; // '22' OC · '1470000113' solicitud de pedido
  IsDraft?: unknown; // 'Y' | 'N'
  ObjectEntry?: unknown;
  Status?: unknown; // arsPending | arsApproved | arsNotApproved | arsGenerated
  Remarks?: unknown;
  CurrentStage?: unknown;
  OriginatorID?: unknown;
  CreationDate?: unknown;
  CreationTime?: unknown;
  DraftEntry?: unknown;
  DraftType?: unknown;
  ApprovalRequestLines?: unknown;
}

/** Borrador (Drafts) con `$select` reducido — sin DocumentLines. */
export interface SapRawDraftSlim {
  DocEntry?: unknown;
  DocNum?: unknown;
  DocDate?: unknown;
  DocObjectCode?: unknown; // oPurchaseOrders | oPurchaseRequest | ...
  DocumentStatus?: unknown;
  AuthorizationStatus?: unknown;
  Requester?: unknown;
  RequesterName?: unknown;
  CardName?: unknown;
  DocTotal?: unknown;
  DocCurrency?: unknown;
  Comments?: unknown;
}

export interface SapRawUser {
  InternalKey?: unknown;
  UserCode?: unknown;
  UserName?: unknown;
}

export interface SapRawApprovalStage {
  Code?: unknown;
  Name?: unknown;
}

export interface SapRawApprovalTemplate {
  Code?: unknown;
  Name?: unknown;
}
