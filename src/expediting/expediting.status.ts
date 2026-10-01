import { MS_PER_DAY } from '../contracts/contracts.dates';

/**
 * Fase Expeditación — Motor de estatus DERIVADO (regla 3): función pura con
 * reloj inyectado, usada por listado, detalle, stats y job. Lo único
 * persistido es lo capturado (delivery_status del tracking); el resto sale
 * de fechas.
 *
 * Umbrales (T9, §Alertas del doc — días NATURALES, no hábiles):
 *  - preventiva / en_riesgo: faltan ≤ 15 días para la fecha esperada
 *  - recordatorio: fecha esperada vencida (días 1..6, una vez por vencimiento)
 *  - crítica: ≥ 7 días de vencida (diaria)
 *
 * I1 (go-live 2026-09-30): una OC de los ERP cerrada o cancelada en
 * CUALQUIERA de los dos sistemas no es una entrega pendiente, y en Maximo la
 * entrega se cierra por la recepción (RECEIPTS = COMPLETE), no por el
 * estatus. Ver `erpClosure`.
 */

export const RISK_WINDOW_DAYS = 15;
export const CRITICAL_AFTER_DAYS = 7;

export type DerivedDeliveryStatus =
  | 'sin_fecha'
  | 'en_tiempo'
  | 'en_riesgo'
  | 'retrasada'
  | 'parcial'
  | 'entregada'
  | 'cancelada';

export interface DeliveryStatusInput {
  /** Fecha esperada vigente (tracking.expected_date ?? PO.expected_delivery_date) */
  expected_date: Date | null;
  actual_delivery_date: Date | null;
  po_status: string | null;
  tracking_status: string | null; // delivery_status capturado, si hay tracking
}

/** Días calendario entre hoy (UTC-midnight) y la fecha; negativo = vencida. */
export function daysUntilDate(date: Date, todayUtc: Date): number {
  return Math.round((date.getTime() - todayUtc.getTime()) / MS_PER_DAY);
}

export function deriveDeliveryStatus(
  input: DeliveryStatusInput,
  todayUtc: Date,
): DerivedDeliveryStatus {
  if (
    input.po_status === 'entregada_completa' ||
    input.tracking_status === 'entregada' ||
    input.actual_delivery_date !== null
  ) {
    return 'entregada';
  }
  if (
    input.po_status === 'entregada_parcial' ||
    input.tracking_status === 'entregada_parcial'
  ) {
    return 'parcial';
  }
  if (!input.expected_date) return 'sin_fecha';
  const daysLeft = daysUntilDate(input.expected_date, todayUtc);
  if (daysLeft < 0) return 'retrasada';
  if (daysLeft <= RISK_WINDOW_DAYS) return 'en_riesgo';
  return 'en_tiempo';
}

/** Por qué una OC del ERP ya no es entrega pendiente (badge de la fila). */
export type ErpClosedBy =
  | 'cerrada_maximo'
  | 'cancelada_maximo'
  | 'cerrada_sap'
  | 'cancelada_sap'
  | 'recepcion_completa';

export const ERP_CLOSED_BY_LABELS: Record<ErpClosedBy, string> = {
  cerrada_maximo: 'Cerrada en Maximo',
  cancelada_maximo: 'Cancelada en Maximo',
  cerrada_sap: 'Cerrada en SAP',
  cancelada_sap: 'Cancelada en SAP',
  recepcion_completa: 'Recepción completa en Maximo',
};

/** I1b: recepción de Maximo (RECEIPTS) en palabras. */
export const RECEIPT_STATUS_LABELS: Record<string, string> = {
  COMPLETE: 'recepción completa',
  PARTIAL: 'recepción parcial',
  NONE: 'sin recepción',
};

/** "INPRG en Maximo · recepción completa" (tooltip y export). */
export function maximoStatusText(row: {
  maximo_status: string | null;
  receipt_status: string | null;
}): string | null {
  if (!row.maximo_status) return null;
  const receipt = row.receipt_status
    ? (RECEIPT_STATUS_LABELS[row.receipt_status.toUpperCase()] ??
      `recepción ${row.receipt_status}`)
    : null;
  return receipt ? `${row.maximo_status} · ${receipt}` : row.maximo_status;
}

export interface ErpClosureInput {
  /** Estatus en Maximo: el de la OC de Maximo o el de la que originó la de SAP. */
  maximo_status: string | null;
  /** Copia en SAP de una OC de Maximo: cerrada / cancelada (no aplica a la fila de SAP). */
  sap_closed?: boolean;
  sap_cancelled?: boolean;
  /** I1b: recepción de Maximo (RECEIPTS): NONE / PARTIAL / COMPLETE; null = no llega. */
  receipt_status: string | null;
}

const MAXIMO_CANCELLED = new Set(['CAN', 'CANCEL']);

/**
 * I1 — Cierre de una OC del ERP fuera de su propio estatus:
 *  - I1a (ya): cerrada (CLOSE) o cancelada (CAN) en Maximo, o su copia en SAP
 *    cerrada o cancelada → entregada / cancelada, aunque el otro sistema la
 *    tenga abierta;
 *  - I1b (cuando CIISA exponga RECEIPTS): recepción COMPLETE → entregada.
 *    PARTIAL sigue abierta (con badge); NONE o null, como hoy.
 * null = sigue abierta y se deriva por su fecha comprometida.
 */
export function erpClosure(
  input: ErpClosureInput,
): { status: 'entregada' | 'cancelada'; closed_by: ErpClosedBy } | null {
  const maximo = input.maximo_status?.toUpperCase() ?? null;
  if (maximo && MAXIMO_CANCELLED.has(maximo)) {
    return { status: 'cancelada', closed_by: 'cancelada_maximo' };
  }
  if (maximo === 'CLOSE') {
    return { status: 'entregada', closed_by: 'cerrada_maximo' };
  }
  if (input.sap_cancelled) {
    return { status: 'cancelada', closed_by: 'cancelada_sap' };
  }
  if (input.sap_closed) {
    return { status: 'entregada', closed_by: 'cerrada_sap' };
  }
  if (input.receipt_status?.toUpperCase() === 'COMPLETE') {
    return { status: 'entregada', closed_by: 'recepcion_completa' };
  }
  return null;
}
