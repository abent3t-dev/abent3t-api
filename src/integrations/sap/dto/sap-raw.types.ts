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

/** Sobre estándar de colección OData del Service Layer. */
export interface SapRawCollection {
  value?: unknown;
}
