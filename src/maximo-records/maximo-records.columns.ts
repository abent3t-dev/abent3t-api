import type { ColumnDefs } from '../common/column-filters/column-filters';
import { buyerLabel } from '../common/utils/buyer.util';
// Funciones puras sin dependencias (solo contracts.dates): no crea ciclo
import {
  integrationStatusLabel,
  receiptStatusLabel,
} from '../expediting/expediting.status';
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

/** Días enteros de `from` a `to`; null si falta alguna o es negativo. */
function daysBetween(from: Date | null, to: Date | null): number | null {
  if (!from || !to) return null;
  const days = Math.round(
    (new Date(to).getTime() - new Date(from).getTime()) / MS_PER_DAY,
  );
  return days < 0 ? null : days;
}

/**
 * Días de aprobación del contrato (solicitud → aprobación, fechas del
 * contrato: `created_at_source` y `approved_at`); null = N/D. Contratos.
 */
export function maximoPrApprovalDays(row: MaximoContractView): number | null {
  return daysBetween(row.created_at_source, row.approved_at);
}

/**
 * K4.4: días de aprobación DE LA PR = primer APPR (llegada a Compras) −
 * ISSUEDATE; null = N/D. Solicitudes (`vista=solicitudes`).
 */
export function maximoPrDays(row: MaximoContractView): number | null {
  return daysBetween(row.pr_issue_date, row.pr_approved_at);
}

/**
 * K7.1 (2026-10-05): `recepcion` e `integracion` con las etiquetas de
 * Expeditación ("Completa", "No disponible"; "Procesado", "Sin dato"…);
 * `oc_sap` como texto (igual que en Expeditación; el orden es numérico) y
 * `subtotal` (sin IVA) aparte de `monto` (TOTALCOST, con IVA).
 */
export const MAXIMO_PO_FILTER_COLUMNS: ColumnDefs<MaximoPurchaseOrderView> = {
  ponum: { type: 'text', value: (r) => r.ponum },
  descripcion: { type: 'text', value: (r) => r.description },
  estatus: { type: 'text', value: (r) => r.status },
  recepcion: {
    type: 'text',
    value: (r) => receiptStatusLabel(r.receipt_status),
  },
  integracion: {
    type: 'text',
    value: (r) => integrationStatusLabel(r.integration_status),
  },
  oc_sap: { type: 'text', value: (r) => r.oc_sap },
  // G1: el proveedor efectivo (según SAP cuando la OC migró o por cruce)
  proveedor: { type: 'text', value: (r) => r.supplier_name },
  subtotal: { type: 'number', value: (r) => r.subtotal },
  monto: { type: 'number', value: (r) => r.total_cost },
  moneda: { type: 'text', value: (r) => r.currency },
  solicitante: {
    type: 'text',
    value: (r) => r.requested_by_name ?? r.requested_by,
  },
  comprador: { type: 'text', value: buyerLabel },
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
  proveedor: { type: 'text', value: (r) => r.supplier_name },
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

/**
 * K4.4 (2026-10-05): Solicitudes (`vista=solicitudes`, una fila por PR) =
 * las de Contratos con las fechas y el estatus DE LA PR: `estatus_pr`
 * nueva; `solicitud` = ISSUEDATE; `aprobacion` = primer APPR (llegada a
 * Compras); `dias` = aprobación − emisión de la PR. `estatus` (el del
 * contrato) se queda.
 */
export const MAXIMO_REQUEST_FILTER_COLUMNS: ColumnDefs<MaximoContractView> = {
  ...MAXIMO_CONTRACT_FILTER_COLUMNS,
  estatus_pr: { type: 'text', value: (r) => r.pr_status },
  solicitud: { type: 'date', value: (r) => r.pr_issue_date },
  aprobacion: { type: 'date', value: (r) => r.pr_approved_at },
  dias: { type: 'number', value: maximoPrDays },
};
