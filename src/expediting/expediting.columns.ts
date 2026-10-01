import type { ColumnDefs } from '../common/column-filters/column-filters';
import {
  ERP_CLOSED_BY_LABELS,
  type DerivedDeliveryStatus,
  type ErpClosedBy,
} from './expediting.status';
import { buyerLabel } from '../common/utils/buyer.util';
import type { BuyerKind } from '../common/utils/buyer.util';

export { buyerLabel };

/**
 * E1/E3/E4 (2026-09-25) — Columnas de la tabla de Expeditación: las mismas
 * para el filtro "tipo Excel", el orden y el export.
 *
 * I1/I2 (2026-09-30): "PO Maximo" y "OC SAP" en columnas propias, y el
 * cierre en el otro sistema ("Cerrada en Maximo", "Cancelada en SAP", …).
 */

/** Forma mínima de una fila de expeditación que leen las columnas. */
export interface ExpeditingColumnRow {
  source: 'abent' | 'sap' | 'maximo';
  purchase_order_id: string | null;
  po_number: string;
  maximo_ponum: string | null;
  po_maximo: string | null;
  oc_sap: string | null;
  closed_by: ErpClosedBy | null;
  supplier: { legal_name: string } | null;
  buyer_name: string | null;
  buyer_kind: BuyerKind;
  effective_expected_date: Date | null;
  delivery_status: DerivedDeliveryStatus;
  days_left: number | null;
  tracking: { alert_count: number } | null;
}

/** Origen filtrable: la OC de SAP creada desde Maximo es su propio valor. */
export function expeditingOrigin(row: {
  source: 'abent' | 'sap' | 'maximo';
  maximo_ponum: string | null;
}): string {
  return row.source === 'sap' && row.maximo_ponum ? 'sap_maximo' : row.source;
}

/** Días que muestra la tabla: una entregada o cancelada ya no cuenta días. */
export function expeditingDays(row: {
  delivery_status: DerivedDeliveryStatus;
  days_left: number | null;
}): number | null {
  return row.delivery_status === 'entregada' ||
    row.delivery_status === 'cancelada'
    ? null
    : row.days_left;
}

/** I1: "Cerrada en Maximo" y similares; null = sigue abierta en su sistema. */
export function expeditingClosedBy(row: {
  closed_by: ErpClosedBy | null;
}): string | null {
  return row.closed_by ? ERP_CLOSED_BY_LABELS[row.closed_by] : null;
}

export const EXPEDITING_FILTER_COLUMNS: ColumnDefs<ExpeditingColumnRow> = {
  po: { type: 'text', value: (r) => r.po_number },
  po_maximo: { type: 'text', value: (r) => r.po_maximo },
  oc_sap: {
    type: 'text',
    // ABENT: su propio número va en la columna de la OC
    value: (r) => (r.source === 'abent' ? r.po_number : r.oc_sap),
  },
  origen: { type: 'text', value: expeditingOrigin },
  proveedor: { type: 'text', value: (r) => r.supplier?.legal_name },
  comprador: { type: 'text', value: buyerLabel },
  fecha: { type: 'date', value: (r) => r.effective_expected_date },
  dias: { type: 'number', value: expeditingDays },
  estatus: { type: 'text', value: (r) => r.delivery_status },
  cierre: { type: 'text', value: expeditingClosedBy },
  alertas: {
    type: 'number',
    value: (r) => (r.purchase_order_id ? (r.tracking?.alert_count ?? 0) : null),
  },
};
