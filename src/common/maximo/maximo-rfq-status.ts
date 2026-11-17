/**
 * O2 (2026-11-17) — Estatus de una solicitud de cotización (RQ) de Maximo,
 * como los manda AB_COTIZACIONES (cabecera y RFQSTATUS):
 *   INPRG = en progreso · SENT = enviada a proveedores · WREV = en revisión ·
 *   CLOSE = cerrada · CANCEL = cancelada.
 * Cerrada = CLOSE; cancelada = CANCEL (o CAN, por si acaso); cualquier otro,
 * abierta (INPRG, SENT, WREV y lo que venga). En 2026, SENT y WREV solo salen
 * en el historial (consulta del 17-nov).
 *
 * Vive en `common` porque la usan el mapper de la integración (fechas de
 * cierre y cancelación) y el avance semanal (estado de cada RQ a un corte),
 * que no importa del módulo de integración.
 */
export type EstadoRfq = 'cerrada' | 'cancelada' | 'abierta';

export const RFQ_ESTATUS_CERRADA: readonly string[] = ['CLOSE'];
export const RFQ_ESTATUS_CANCELADA: readonly string[] = ['CANCEL', 'CAN'];

/** Estado de una RQ por su estatus de Maximo (sin estatus = abierta). */
export function estadoDeRfq(status: string | null | undefined): EstadoRfq {
  const s = (status ?? '').trim().toUpperCase();
  if (RFQ_ESTATUS_CERRADA.includes(s)) return 'cerrada';
  if (RFQ_ESTATUS_CANCELADA.includes(s)) return 'cancelada';
  return 'abierta';
}
