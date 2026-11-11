import { cdmxDateUtc } from '../contracts/contracts.dates';

/**
 * FP&A (bloque C, C4) — fecha límite de captura y prórroga por área.
 * Funciones puras, sin base. Lo que contestó Laura el 10-nov
 * (documentation/FPA.md, "Reunión del 4-nov", punto 3): una fecha para todas
 * las áreas, al vencer se bloquea, y las firmas no llevan fecha.
 *
 * - La fecha de la versión es el último día para capturar y enviar, en hora
 *   de México.
 * - Al pasar, un presupuesto en borrador (nunca enviado, o retirado) ya no se
 *   captura ni se envía, y uno enviado ya no se retira. Planeación (y soporte)
 *   sigue editando: administra la versión.
 * - Un devuelto (lo regresó quien firma, o planeación lo reabrió) se corrige y
 *   se reenvía sin fecha: las firmas no llevan fecha.
 * - Planeación le da a un área una prórroga: vale la fecha más tarde de las
 *   dos.
 */

/** Un día del calendario, 'YYYY-MM-DD'. */
export type IsoDay = string;

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** El aviso a quien captura sale cuando faltan estos días hábiles o menos. */
export const NOTICE_BUSINESS_DAYS = 2;

/** Planeación recibe la lista de las áreas sin enviar hasta estos días hábiles después. */
export const LATE_LIST_BUSINESS_DAYS = 3;

/** 'YYYY-MM-DD' de una columna date (Prisma la da en medianoche UTC). */
export const dayOf = (d: Date | null | undefined): IsoDay | null =>
  d ? d.toISOString().slice(0, 10) : null;

/** Una columna date a partir de 'YYYY-MM-DD'. */
export const dateOf = (d: IsoDay): Date => new Date(`${d}T00:00:00.000Z`);

/** Hoy, en México. */
export const todayMx = (now: Date = new Date()): IsoDay =>
  cdmxDateUtc(now).toISOString().slice(0, 10);

/** El día siguiente. */
export const nextDay = (d: IsoDay): IsoDay =>
  new Date(dateOf(d).getTime() + 86_400_000).toISOString().slice(0, 10);

/** ¿Es un día que existe? ('2026-02-30' no). */
export function isRealDay(d: string): boolean {
  if (!ISO_DAY.test(d)) return false;
  const t = dateOf(d);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** "20 de noviembre de 2026". */
export function dayLabel(d: IsoDay): string {
  const [y, m, day] = d.split('-').map(Number);
  return `${day} de ${MONTHS[m - 1]} de ${y}`;
}

/** Hasta qué día captura el área: la fecha de la versión o su prórroga, la más tarde. */
export function captureUntil(
  deadline: IsoDay | null,
  extendedUntil: IsoDay | null,
): IsoDay | null {
  if (!deadline) return null;
  return extendedUntil && extendedUntil > deadline ? extendedUntil : deadline;
}

export interface DeadlineInput {
  /** Estado de la versión: solo cuenta abierta a captura. */
  version_status: string;
  /** Estado del presupuesto. */
  status: string;
  deadline: IsoDay | null;
  extended_until: IsoDay | null;
}

/** ¿Ya pasó el día que vale para el área? (hoy es después) */
export function pastDeadline(i: DeadlineInput, today: IsoDay): boolean {
  const until = captureUntil(i.deadline, i.extended_until);
  return i.version_status === 'captura' && until !== null && today > until;
}

/** ¿El área ya no captura ni envía? Solo un borrador, con la fecha vencida. */
export function captureClosed(i: DeadlineInput, today: IsoDay): boolean {
  return i.status === 'borrador' && pastDeadline(i, today);
}

/** Lo que se le dice a quien captura cuando ya cerró. */
export const closedReason = (until: IsoDay) =>
  `La captura cerró el ${dayLabel(until)}: planeación puede darle una prórroga al área`;

/** Por qué ya no se retira un envío. */
export const withdrawReason = (until: IsoDay) =>
  `La fecha de captura ya pasó (${dayLabel(until)}): si hay que corregir algo, que lo regrese quien aprueba el área`;

/** La fecha y la prórroga de un presupuesto, para las pantallas. */
export interface CaptureWindow {
  /** La fecha de la versión. */
  deadline: IsoDay | null;
  /** La prórroga del área, si tiene. */
  extended_until: IsoDay | null;
  /** Hasta qué día captura el área (la más tarde de las dos). */
  until: IsoDay | null;
  /** Ya no captura ni envía (borrador con la fecha vencida). */
  closed: boolean;
}

export function captureWindow(i: DeadlineInput, today: IsoDay): CaptureWindow {
  return {
    deadline: i.deadline,
    extended_until: i.extended_until,
    until: captureUntil(i.deadline, i.extended_until),
    closed: captureClosed(i, today),
  };
}
