import type { ColumnDefs } from '../common/column-filters/column-filters';
import type {
  MaximoContractView,
  MaximoPurchaseOrderView,
} from './maximo-records.types';

/**
 * E1 (2026-09-25) — Columnas filtrables ("tipo Excel") de Órdenes Maximo y
 * de las pestañas Contratos Maximo / Solicitudes Maximo (ambas leen
 * /maximo/contracts): el valor es el que la tabla muestra.
 */

const MS_PER_DAY = 86_400_000;

/** Días de aprobación de la PR (solicitud → aprobación); null = N/D. */
export function maximoPrApprovalDays(row: MaximoContractView): number | null {
  if (!row.created_at_source || !row.approved_at) return null;
  const days = Math.round(
    (new Date(row.approved_at).getTime() -
      new Date(row.created_at_source).getTime()) /
      MS_PER_DAY,
  );
  return days < 0 ? null : days;
}

export const MAXIMO_PO_FILTER_COLUMNS: ColumnDefs<MaximoPurchaseOrderView> = {
  ponum: { type: 'text', value: (r) => r.ponum },
  descripcion: { type: 'text', value: (r) => r.description },
  estatus: { type: 'text', value: (r) => r.status },
  proveedor: { type: 'text', value: (r) => r.vendor_name },
  monto: { type: 'number', value: (r) => r.total_cost },
  moneda: { type: 'text', value: (r) => r.currency },
  solicitante: {
    type: 'text',
    value: (r) => r.requested_by_name ?? r.requested_by,
  },
  comprador: { type: 'text', value: (r) => r.buyer_name },
  depto: { type: 'text', value: (r) => r.department },
  clasificacion: { type: 'text', value: (r) => r.ab_clasfpo },
  ahorro: { type: 'number', value: (r) => r.ab_ahorro },
  aprobacion: { type: 'date', value: (r) => r.approved_at },
};

export const MAXIMO_CONTRACT_FILTER_COLUMNS: ColumnDefs<MaximoContractView> = {
  pr: { type: 'text', value: (r) => r.prnum },
  contrato: {
    type: 'text',
    value: (r) => (r.has_contract ? r.contractnum : null),
  },
  estatus: { type: 'text', value: (r) => r.status },
  proveedor: { type: 'text', value: (r) => r.vendor_name },
  valor: { type: 'number', value: (r) => r.contract_value },
  consumido: { type: 'number', value: (r) => r.consumed_value },
  saldo: { type: 'number', value: (r) => r.balance_value },
  moneda: { type: 'text', value: (r) => r.currency },
  inicio: { type: 'date', value: (r) => r.start_date },
  fin: { type: 'date', value: (r) => r.end_date },
  depto: { type: 'text', value: (r) => r.department },
  revision: { type: 'number', value: (r) => r.revisionnum },
  solicitud: { type: 'date', value: (r) => r.created_at_source },
  aprobacion: { type: 'date', value: (r) => r.approved_at },
  dias: { type: 'number', value: maximoPrApprovalDays },
  monto_pr: { type: 'number', value: (r) => r.pr_total },
  solicitante: {
    type: 'text',
    value: (r) => r.requested_by_name ?? r.requested_by,
  },
};
