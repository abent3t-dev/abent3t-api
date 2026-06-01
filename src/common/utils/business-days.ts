/**
 * business-days.ts — sustituye la RPC PostgreSQL `calculate_business_days`
 * por una implementación en TypeScript (Checkpoint 1 §K-2 del AUDIT).
 *
 * Reglas:
 *   * Recorre día a día entre `start` y `end` (inclusive).
 *   * Excluye sábados (DOW=6) y domingos (DOW=0).
 *   * Excluye los días que aparezcan en `holidays` (activos en BD).
 *
 * El caller normalmente usa `BusinessDaysService` (servicio inyectable con
 * cache de holidays). El util "puro" se exporta para tests y para casos
 * donde el set de holidays se conoce de antemano.
 */

/** Compara solo la fecha (no la hora) — usa medianoche UTC. */
function toUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function dateKey(d: Date): string {
  // YYYY-MM-DD en UTC. Estable para comparar contra holidays.holiday_date.
  return toUtcMidnight(d).toISOString().slice(0, 10);
}

/**
 * Versión pura: recibe el array de holidays y devuelve el conteo de días
 * hábiles entre `start` y `end` (inclusive).
 *
 * `holidays` puede venir como `Date[]` o como `string[]` ISO ('YYYY-MM-DD').
 */
export function calculateBusinessDays(
  start: Date | string,
  end: Date | string,
  holidays: ReadonlyArray<Date | string>,
): number {
  const s = toUtcMidnight(new Date(start));
  const e = toUtcMidnight(new Date(end));
  if (s > e) return 0;

  const holidaySet = new Set<string>(
    holidays.map((h) => (typeof h === 'string' ? h.slice(0, 10) : dateKey(h))),
  );

  let count = 0;
  const cur = new Date(s);
  while (cur <= e) {
    const dow = cur.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dow !== 0 && dow !== 6 && !holidaySet.has(dateKey(cur))) {
      count++;
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}
