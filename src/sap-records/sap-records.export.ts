import { NO_DISPONIBLE } from '../common/utils/excel-export.util';
import type { ExcelColumn } from '../common/utils/excel-export.util';
import type {
  SapPurchaseOrderRow,
  SapPurchaseRequestRow,
} from './sap-records.types';

/**
 * Columnas de Excel de OC y solicitudes de SAP: las usan el export de las
 * pestañas (B1) y el reporte semanal de Compras.
 */

const STATUS_LABEL: Record<string, string> = {
  open: 'Abierta',
  close: 'Cerrada',
  cancelled: 'Cancelada',
};

export const sapStatusLabel = (row: {
  status_key: string | null;
  document_status: string | null;
}) =>
  (row.status_key && STATUS_LABEL[row.status_key]) || row.document_status || '';

const clasif = (row: { lines_total: number; lines_classified: number }) =>
  row.lines_total === 0
    ? ''
    : row.lines_classified === 0
      ? 'Sin clasificar'
      : `${row.lines_classified}/${row.lines_total}`;

/** Saldo: una cancelada no tiene (vacío); sin calcular → "No disponible". */
export const sapPoSaldo = (row: SapPurchaseOrderRow) =>
  row.status_key === 'cancelled' ? null : (row.open_total ?? NO_DISPONIBLE);

/**
 * Solicitante(s) de las solicitudes base de SAP o, si la OC la creó la
 * integración con Maximo, su solicitante en Maximo. Vacío si no hay.
 */
export const sapPoRequesters = (row: SapPurchaseOrderRow) =>
  row.requester_names.length > 0
    ? row.requester_names.join(', ')
    : (row.maximo_requested_by ?? '');

/** Columnas del export = columnas visibles de la pestaña "Ordenes SAP" (B1). */
export const SAP_PO_EXPORT_COLUMNS: ExcelColumn<SapPurchaseOrderRow>[] = [
  { header: 'Número', value: (r) => r.doc_num, kind: 'int', width: 12 },
  { header: 'DocEntry', value: (r) => r.doc_entry, kind: 'int', width: 12 },
  { header: 'Proveedor', value: (r) => r.card_name, width: 40 },
  { header: 'Código proveedor', value: (r) => r.card_code, width: 16 },
  { header: 'Estatus', value: sapStatusLabel, width: 12 },
  { header: 'Monto', value: (r) => r.doc_total, kind: 'money', width: 16 },
  {
    header: 'Saldo disponible',
    value: sapPoSaldo,
    kind: 'money',
    width: 16,
  },
  { header: 'Moneda', value: (r) => r.currency, width: 10 },
  { header: 'Solicitante', value: sapPoRequesters, width: 32 },
  { header: 'OC Maximo', value: (r) => r.maximo_ponum, width: 14 },
  { header: 'Capturó (SAP)', value: (r) => r.created_by_name, width: 28 },
  { header: 'F. Documento', value: (r) => r.doc_date, kind: 'date', width: 14 },
  {
    header: 'F. Entrega',
    value: (r) => r.doc_due_date,
    kind: 'date',
    width: 14,
  },
  {
    header: 'F. Cierre',
    value: (r) => r.closing_date,
    kind: 'date',
    width: 14,
  },
  { header: 'Autorización', value: (r) => r.authorization_status, width: 16 },
  { header: 'Líneas', value: (r) => r.lines_total, kind: 'int', width: 10 },
  { header: 'Clasif. líneas', value: clasif, width: 14 },
  {
    header: 'Ahorro',
    value: (r) => r.ahorro_total ?? NO_DISPONIBLE,
    width: 14,
  },
  { header: 'Comentarios', value: (r) => r.comments, width: 40 },
];

export const SAP_PR_EXPORT_COLUMNS: ExcelColumn<SapPurchaseRequestRow>[] = [
  { header: 'Número', value: (r) => r.doc_num, kind: 'int', width: 12 },
  { header: 'DocEntry', value: (r) => r.doc_entry, kind: 'int', width: 12 },
  { header: 'Solicitante', value: (r) => r.requester_name, width: 32 },
  { header: 'Usuario', value: (r) => r.requester, width: 14 },
  { header: 'Estatus', value: sapStatusLabel, width: 12 },
  {
    header: 'Monto (líneas, sin IVA)',
    value: (r) => r.doc_total,
    kind: 'money',
    width: 18,
  },
  { header: 'Moneda', value: (r) => r.currency, width: 10 },
  { header: 'F. Documento', value: (r) => r.doc_date, kind: 'date', width: 14 },
  {
    header: 'F. Requerida',
    value: (r) => r.required_date,
    kind: 'date',
    width: 14,
  },
  {
    header: 'F. Cierre',
    value: (r) => r.closing_date,
    kind: 'date',
    width: 14,
  },
  { header: 'Autorización', value: (r) => r.authorization_status, width: 16 },
  { header: 'Líneas', value: (r) => r.lines_total, kind: 'int', width: 10 },
  { header: 'Clasif. líneas', value: clasif, width: 14 },
  {
    header: 'Ahorro',
    value: (r) => r.ahorro_total ?? NO_DISPONIBLE,
    width: 14,
  },
  { header: 'Comentarios', value: (r) => r.comments, width: 40 },
];
