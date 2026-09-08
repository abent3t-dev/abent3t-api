/**
 * Fase §15 — Fechas del dominio de contratos.
 *
 * Las columnas `date` de Prisma llegan como Date en medianoche UTC; para que
 * "hoy" signifique el día calendario en CDMX (donde opera procura y donde
 * corre el cron de 08:00), se proyecta el instante actual a la fecha civil de
 * America/Mexico_City y se representa igual (medianoche UTC). Así la resta
 * directa de timestamps da días calendario exactos.
 */

const CDMX_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const MS_PER_DAY = 86_400_000;

/** Fecha civil CDMX del instante dado, como Date en medianoche UTC. */
export function cdmxDateUtc(now: Date = new Date()): Date {
  const [year, month, day] = CDMX_FORMATTER.format(now).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Días calendario entre hoy (CDMX) y la fecha dada (negativo si ya pasó). */
export function daysUntil(endDate: Date, todayUtc: Date): number {
  return Math.round((endDate.getTime() - todayUtc.getTime()) / MS_PER_DAY);
}
