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
 */

export const RISK_WINDOW_DAYS = 15;
export const CRITICAL_AFTER_DAYS = 7;

export type DerivedDeliveryStatus =
  | 'sin_fecha'
  | 'en_tiempo'
  | 'en_riesgo'
  | 'retrasada'
  | 'parcial'
  | 'entregada';

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
