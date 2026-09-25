/**
 * Fase INT-4 — Tipos del módulo de lectura de staging SAP.
 *
 * Misma serialización que el módulo de lectura de Int-5: montos como
 * `number` (Decimal(15,2) es representable exacto en double), fechas como
 * Date (Nest emite ISO 8601), nulls explícitos — `null` en los 3 campos de
 * clasificación/ahorro significa "sin capturar en el ERP" y la UI lo pinta
 * como "No disponible", nunca como 0. `raw` solo existe en el detalle para
 * PURCHASE_ADMINS (omitirlo ES el control de acceso).
 *
 * Sprint 2026-09-22 (A6): estatus DERIVADO `status_key` — SAP no distingue
 * una cancelada por DocumentStatus (llega bost_Close) sino por `Cancelled`:
 *   cancelled=true → 'cancelled'; bost_Open → 'open'; bost_Close → 'close'.
 * `null` = fila sincronizada antes de la migración 0011 y sin re-sync (se
 * muestra como el DocumentStatus crudo, nunca se inventa).
 */

export type SapDocStatusKey = 'open' | 'close' | 'cancelled';

interface SapDocBaseRow {
  id: string;
  doc_entry: number;
  doc_num: number | null;
  doc_date: Date | null;
  doc_due_date: Date | null;
  update_date_source: Date | null;
  document_status: string | null;
  /** Estatus derivado (A6). null solo si `cancelled` aún no se sincronizó. */
  status_key: SapDocStatusKey | null;
  cancelled: boolean | null;
  authorization_status: string | null;
  closing_date: Date | null;
  comments: string | null;
  doc_total: number | null;
  currency: string | null;
  lines_total: number;
  lines_classified: number;
  ahorro_total: number | null;
  last_changed_at: Date | null;
  last_seen_at: Date;
}

export interface SapPurchaseOrderRow extends SapDocBaseRow {
  card_code: string | null;
  card_name: string | null;
  /**
   * Saldo disponible: lo que falta por recibir/facturar, con IVA y en la
   * moneda del documento. null = sin calcular (sync previo a 1.2.0).
   */
  open_total: number | null;
  /** InternalKey y nombre del usuario de SAP que capturó la OC. */
  user_sign: number | null;
  created_by_name: string | null;
  /** PONUM de Maximo si la OC la creó la integración Maximo → SAP. */
  maximo_ponum: string | null;
  /**
   * D1: la OC migrada EXISTE en el staging de Maximo → se cuenta una sola
   * vez en los totales combinados (se descuenta del lado SAP).
   */
  maximo_po_exists: boolean;
  /** Solicitante en Maximo (REQUESTEDBY de su PR; nombre si hay alias, D6). */
  maximo_requested_by: string | null;
  /** DocEntry de las solicitudes de pedido de las que se copiaron líneas. */
  base_request_entries: number[];
  /** Solicitantes de esas solicitudes (vacío = la OC no nació de una). */
  requester_names: string[];
  /**
   * E4: comprador. SAP no lo trae en ninguna OC de PRD (SalesPersonCode =
   * -1): la migrada de Maximo toma el PURCHASEAGENT de allá (`comprador`);
   * las demás, quién la capturó (`capturo`, la UI dice "Capturó: …").
   */
  buyer_name: string | null;
  buyer_kind: 'comprador' | 'capturo' | null;
}

export interface SapPurchaseRequestRow extends SapDocBaseRow {
  required_date: Date | null;
  requester: string | null;
  requester_name: string | null;
}

/** Línea derivada de raw.DocumentLines para el detalle. */
export interface SapDocumentLineView {
  lineNum: number | null;
  itemCode: string | null;
  itemDescription: string | null;
  /** Sin IVA, en la moneda del documento (`currency`). */
  lineTotal: number | null;
  currency: string | null;
  quantity: number | null;
  /** Cantidad aún no recibida/facturada. */
  openQuantity: number | null;
  lineStatus: 'open' | 'close' | null;
  /** Pendiente de la línea con IVA; 0 si está cerrada, null si no se sabe. */
  openTotal: number | null;
  /** null = sin capturar en el ERP → la UI muestra "No disponible". */
  clasGts: string | null;
  impAhorro: number | null;
  procComp: string | null;
}

export interface SapPurchaseOrderDetail {
  document: SapPurchaseOrderRow;
  lines: SapDocumentLineView[];
  raw?: unknown;
}

export interface SapPurchaseRequestDetail {
  document: SapPurchaseRequestRow;
  lines: SapDocumentLineView[];
  raw?: unknown;
}

/** Conteo por estatus DERIVADO (`open` | `close` | `cancelled`). */
export interface SapStatusCount {
  status: string | null;
  count: number;
}

/** Monto por moneda (regla del sprint: nunca sumar MXN con USD). */
export interface SapCurrencyAmount {
  currency: string | null;
  total: number;
  count: number;
}

export interface SapLastSyncRun {
  status: string;
  triggered_by: string;
  mode: string;
  started_at: Date;
  finished_at: Date | null;
  records_inserted: number;
  records_updated: number;
  records_unchanged: number;
  records_failed: number;
}

export interface SapEntitySummary {
  total: number;
  byStatus: SapStatusCount[];
  /** Suma de doc_total SIN distinguir moneda (compat; preferir montoPorMoneda). */
  montoTotal: number;
  montoPorMoneda: SapCurrencyAmount[];
  /** Abiertas no canceladas, con monto por moneda ("por recibir"). */
  abiertas: { count: number; montoPorMoneda: SapCurrencyAmount[] };
  linesTotal: number;
  /** Líneas con clasificación REAL capturada (≠ placeholder del ERP). */
  linesClassified: number;
  /** Documentos con al menos una línea de ahorro capturada. */
  docsConAhorro: number;
  /**
   * Días promedio entre doc_date y closing_date (o update_date_source como
   * proxy cuando closing_date aún no se sincronizó) de las cerradas.
   * null = sin base para calcular (nunca 0).
   */
  diasPromedioGestion: number | null;
}

export interface SapSummary {
  /**
   * Refleja SAP_SYNC_ENABLED (leído del env directamente): permite al
   * dashboard distinguir "0 registros porque está apagado" de "0 reales".
   */
  syncEnabled: boolean;
  /** D4: año aplicado (null = todo). */
  year: number | null;
  purchaseOrders: SapEntitySummary;
  purchaseRequests: SapEntitySummary;
  /** Cola de autorización de SAP (B5): pendientes en staging. */
  approvalRequests: { total: number; pending: number };
  /** D1: OC creadas desde Maximo (NumAtCard = PONUM) y cuántas existen allá. */
  migradas: { total: number; en_maximo: number };
  lastSync: {
    purchase_orders: SapLastSyncRun | null;
    purchase_requests: SapLastSyncRun | null;
    approval_requests: SapLastSyncRun | null;
  };
}

// ── Cola de autorización (B5) ─────────────────────────────────────────────

export interface SapApprovalLineView {
  stage_code: number | null;
  stage_name: string | null;
  user_id: number | null;
  user_name: string | null;
  status: string | null;
  update_date: string | null;
}

export interface SapApprovalRequestRow {
  id: string;
  code: number;
  approval_template_id: number | null;
  template_name: string | null;
  object_type: string | null;
  /** 'purchase_order' | 'purchase_request' | 'other' derivado de object_type. */
  document_kind: 'purchase_order' | 'purchase_request' | 'other';
  is_draft: boolean | null;
  draft_entry: number | null;
  object_entry: number | null;
  status: string | null;
  remarks: string | null;
  current_stage: number | null;
  current_stage_name: string | null;
  originator_id: number | null;
  originator_name: string | null;
  creation_date: Date | null;
  /** Días naturales esperando (solo pendientes); null si no aplica. */
  days_waiting: number | null;
  doc_num: number | null;
  doc_date: Date | null;
  doc_total: number | null;
  currency: string | null;
  card_name: string | null;
  requester_name: string | null;
  approvers: SapApprovalLineView[];
  last_changed_at: Date | null;
  last_seen_at: Date;
}
