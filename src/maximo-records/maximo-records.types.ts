/**
 * Fase INT-5 — Tipos del módulo de lectura de staging Maximo.
 *
 * Serialización acordada: montos como `number` (las columnas son
 * Decimal(15,2): cualquier importe realista es representable exacto en un
 * double, mismo criterio que getStats de purchase-orders); fechas como Date
 * (Nest las emite ISO 8601); nulls explícitos, nunca campos omitidos —
 * con la única excepción de `raw`, que solo existe en el detalle para
 * PURCHASE_ADMINS (omitirlo ES el control de acceso).
 */

export interface MaximoPurchaseOrderView {
  id: string;
  ponum: string;
  siteid: string | null;
  revisionnum: number | null;
  status: string | null;
  description: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  total_cost: number | null;
  currency: string | null;
  ab_ahorro: number | null;
  ab_tipocomp: string | null;
  ab_clasfpo: string | null;
  requested_by: string | null;
  department: string | null;
  approved_at: Date | null;
  created_at_source: Date | null;
  last_changed_at: Date | null;
  last_seen_at: Date;
  raw?: unknown;
}

export interface MaximoPurchaseOrderRevision {
  id: string;
  revisionnum: number | null;
  siteid: string | null;
  status: string | null;
  rowstamp: string | null;
  last_changed_at: Date | null;
  last_seen_at: Date;
}

export interface MaximoPurchaseOrderDetail {
  current: MaximoPurchaseOrderView;
  revisions: MaximoPurchaseOrderRevision[];
}

export interface MaximoContractView {
  id: string;
  prnum: string | null;
  contractnum: string | null;
  revisionnum: number | null;
  status: string | null;
  maxvol: number | null;
  total_cost: number | null;
  currency: string | null;
  start_date: Date | null;
  end_date: Date | null;
  vendor_id: string | null;
  vendor_name: string | null;
  requested_by: string | null;
  department: string | null;
  approved_at: Date | null;
  created_at_source: Date | null;
  contract_ref_num: string | null;
  contract_value: number | null;
  purchview_count: number;
  has_contract: boolean;
  last_changed_at: Date | null;
  last_seen_at: Date;
  raw?: unknown;
}

export interface MaximoContractRevision {
  id: string;
  contractnum: string | null;
  revisionnum: number | null;
  status: string | null;
  pr_rowstamp: string | null;
  contract_rowstamp: string | null;
  last_changed_at: Date | null;
  last_seen_at: Date;
}

/** Línea de contrato derivada de raw.CONTRACTLINE (mejor esfuerzo). */
export interface MaximoContractLine {
  lineNum: number | null;
  itemNum: string | null;
  description: string | null;
  quantity: number | null;
  unitCost: number | null;
}

/** Entrada del historial derivado de raw.CONTRACTSTATUS. */
export interface MaximoContractStatusEntry {
  status: string | null;
  changedAt: string | null;
}

export interface MaximoContractDetail {
  current: MaximoContractView;
  revisions: MaximoContractRevision[];
  lines: MaximoContractLine[];
  statusHistory: MaximoContractStatusEntry[];
}

export interface MaximoStatusCount {
  status: string | null;
  count: number;
}

export interface MaximoLastSyncRun {
  status: string;
  triggered_by: string;
  started_at: Date;
  finished_at: Date | null;
  records_inserted: number;
  records_updated: number;
  records_unchanged: number;
  records_failed: number;
}

export interface MaximoSummary {
  /**
   * Refleja MAXIMO_SYNC_ENABLED (leído del env directamente, no de la capa
   * de integración): permite
   * al dashboard distinguir "0 registros porque está apagado" de "0 reales".
   */
  syncEnabled: boolean;
  purchaseOrders: { total: number; byStatus: MaximoStatusCount[] };
  contracts: {
    total: number;
    withContract: number;
    byStatus: MaximoStatusCount[];
  };
  lastSync: {
    purchase_orders: MaximoLastSyncRun | null;
    contracts: MaximoLastSyncRun | null;
  };
}
