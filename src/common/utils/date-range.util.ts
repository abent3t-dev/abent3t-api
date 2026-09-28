/**
 * Límite superior de un rango de fechas recibido por query: un `to` de solo
 * fecha (YYYY-MM-DD) incluye el día completo — misma regla que el periodo de
 * Reportes (resolvePeriod), para que un clic desde un reporte muestre las
 * mismas OC que contó.
 */
export function rangeEnd(to: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(to)
    ? new Date(`${to}T23:59:59.999Z`)
    : new Date(to);
}
