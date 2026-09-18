/**
 * Fase INT-4 — Tipos del módulo de lectura de staging SAP.
 *
 * Misma serialización que el módulo de lectura de Int-5: montos como
 * `number` (Decimal(15,2) es representable exacto en double), fechas como
 * Date (Nest emite ISO 8601), nulls explícitos — `null` en los 3 campos de
 * clasificación/ahorro significa "sin capturar en el ERP" y la UI lo pinta
 * como "No disponible", nunca como 0. `raw` solo existe en el detalle para
 * PURCHASE_ADMINS (omitirlo ES el control de acceso).
 */

export interface SapPurchaseOrderRow {
  id: string;
  doc_entry: number;
  doc_num: number | null;
  doc_date: Date | null;
  doc_due_date: Date | null;
  update_date_source: Date | null;
  document_status: string | null;
  comments: string | null;
  card_code: string | null;
  card_name: string | null;
  doc_total: number | null;
  currency: string | null;
  lines_total: number;
  lines_classified: number;
  ahorro_total: number | null;
  last_changed_at: Date | null;
  last_seen_at: Date;
}

export interface SapPurchaseRequestRow {
  id: string;
  doc_entry: number;
  doc_num: number | null;
  doc_date: Date | null;
  doc_due_date: Date | null;
  required_date: Date | null;
  update_date_source: Date | null;
  document_status: string | null;
  comments: string | null;
  requester: string | null;
  requester_name: string | null;
  doc_total: number | null;
  currency: string | null;
  lines_total: number;
  lines_classified: number;
  ahorro_total: number | null;
  last_changed_at: Date | null;
  last_seen_at: Date;
}

/** Línea derivada de raw.DocumentLines para el detalle. */
export interface SapDocumentLineView {
  lineNum: number | null;
  itemCode: string | null;
  itemDescription: string | null;
  lineTotal: number | null;
  currency: string | null;
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

export interface SapStatusCount {
  status: string | null;
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
  /** Suma de doc_total (montos del documento, no de clasificación). */
  montoTotal: number;
  linesTotal: number;
  /** Líneas con clasificación REAL capturada (≠ placeholder del ERP). */
  linesClassified: number;
  /** Documentos con al menos una línea de ahorro capturada. */
  docsConAhorro: number;
}

export interface SapSummary {
  /**
   * Refleja SAP_SYNC_ENABLED (leído del env directamente): permite al
   * dashboard distinguir "0 registros porque está apagado" de "0 reales".
   */
  syncEnabled: boolean;
  purchaseOrders: SapEntitySummary;
  purchaseRequests: SapEntitySummary;
  lastSync: {
    purchase_orders: SapLastSyncRun | null;
    purchase_requests: SapLastSyncRun | null;
  };
}
