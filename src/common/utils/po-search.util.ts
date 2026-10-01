/**
 * I2 (2026-09-30): número de PO/OC del término de búsqueda: "104896",
 * "PO104896" o "po 104896" → "104896" (el PONUM de Maximo es PO + dígitos).
 * null = el término no es un número de documento.
 */
export function poSearchNumber(search: string | undefined): string | null {
  const compact = (search ?? '').replace(/\s+/g, '');
  const withPrefix = /^po(\d+)$/i.exec(compact);
  if (withPrefix) return withPrefix[1];
  return /^\d+$/.test(compact) ? compact : null;
}
