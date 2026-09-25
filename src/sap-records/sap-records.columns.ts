import type { ColumnDefs } from '../common/column-filters/column-filters';
import { buyerLabel } from '../common/utils/buyer.util';
import type {
  SapPurchaseOrderRow,
  SapPurchaseRequestRow,
} from './sap-records.types';

/**
 * E1 (2026-09-25) — Columnas filtrables ("tipo Excel") de las pestañas
 * Órdenes SAP y Solicitudes SAP: el valor es el que la tabla muestra.
 */

/** Estatus derivado (A6) o, sin él, el DocumentStatus crudo. */
const statusOf = (row: {
  status_key: string | null;
  document_status: string | null;
}) => row.status_key ?? row.document_status;

/** D1: capturada en SAP, migrada de Maximo (existe allá) o referencia manual. */
export function sapPoOriginKey(row: SapPurchaseOrderRow): string {
  if (row.maximo_ponum === null) return 'sap';
  return row.maximo_po_exists ? 'maximo' : 'ref';
}

/** Solicitante(s) de la solicitud base o, si vino de Maximo, el de allá. */
export function sapPoRequesterText(row: SapPurchaseOrderRow): string | null {
  return row.requester_names.length > 0
    ? row.requester_names.join(', ')
    : row.maximo_requested_by;
}

export const SAP_PO_FILTER_COLUMNS: ColumnDefs<SapPurchaseOrderRow> = {
  numero: { type: 'text', value: (r) => r.doc_num },
  origen: { type: 'text', value: sapPoOriginKey },
  proveedor: { type: 'text', value: (r) => r.card_name },
  solicitante: { type: 'text', value: sapPoRequesterText },
  comprador: { type: 'text', value: buyerLabel },
  estatus: { type: 'text', value: statusOf },
  monto: { type: 'number', value: (r) => r.doc_total },
  saldo: {
    type: 'number',
    value: (r) => (r.status_key === 'cancelled' ? null : r.open_total),
  },
  moneda: { type: 'text', value: (r) => r.currency },
  fecha: { type: 'date', value: (r) => r.doc_date },
  entrega: { type: 'date', value: (r) => r.doc_due_date },
};

export const SAP_PR_FILTER_COLUMNS: ColumnDefs<SapPurchaseRequestRow> = {
  numero: { type: 'text', value: (r) => r.doc_num },
  solicitante: { type: 'text', value: (r) => r.requester_name },
  estatus: { type: 'text', value: statusOf },
  monto: { type: 'number', value: (r) => r.doc_total },
  moneda: { type: 'text', value: (r) => r.currency },
  fecha: { type: 'date', value: (r) => r.doc_date },
  requerida: { type: 'date', value: (r) => r.required_date },
};
