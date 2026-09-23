import { Prisma } from '@prisma/client';

/**
 * Bloque 2026-09-23 — fragmentos SQL compartidos por dashboard, reportes,
 * expeditación y lecturas del staging. Una sola definición por regla:
 *
 *  - Vista VIGENTE de Maximo (mayor revisión por clave natural), misma
 *    definición que Int-5.
 *  - D1: una OC de SAP que nació en Maximo (`maximo_ponum`, NumAtCard =
 *    PONUM) y que EXISTE en el staging de Maximo se cuenta UNA sola vez en
 *    los totales combinados: se descuenta del lado de SAP (Maximo la tiene
 *    con su historial de aprobación). Si el PONUM no existe en Maximo
 *    (captura manual con referencia inventada) la OC sí cuenta.
 */

export const CURRENT_MAXIMO_POS = Prisma.sql`
  SELECT DISTINCT ON (ponum, coalesce(siteid, '')) *
  FROM maximo_purchase_orders
  ORDER BY ponum, coalesce(siteid, ''), coalesce(revisionnum, 0) DESC`;

export const CURRENT_MAXIMO_CONTRACTS = Prisma.sql`
  SELECT DISTINCT ON (coalesce(prnum, ''), coalesce(contractnum, '')) *
  FROM maximo_contracts
  ORDER BY coalesce(prnum, ''), coalesce(contractnum, ''),
    coalesce(revisionnum, 0) DESC`;

/**
 * Condición "la OC de SAP está duplicada en Maximo" para una tabla/alias
 * `sap_purchase_orders` referida como `alias`. Úsala negada para contar una
 * vez: `AND NOT (${sapPoDuplicatedInMaximo('s')})`.
 */
export function sapPoDuplicatedInMaximo(alias: string): Prisma.Sql {
  const col = Prisma.raw(`${alias}.maximo_ponum`);
  return Prisma.sql`(${col} IS NOT NULL AND EXISTS (
    SELECT 1 FROM maximo_purchase_orders m WHERE m.ponum = ${col}))`;
}

/** `AND NOT (duplicada)` listo para pegar en un WHERE sobre `alias`. */
export function andSapPoCountedOnce(alias: string): Prisma.Sql {
  return Prisma.sql`AND NOT ${sapPoDuplicatedInMaximo(alias)}`;
}

/**
 * D4: filtro por año calendario sobre una columna timestamptz. `year` null
 * → sin filtro (Prisma.empty). Se compara por rango para usar el índice.
 */
export function andYear(column: string, year: number | null | undefined) {
  if (!year) return Prisma.empty;
  const col = Prisma.raw(column);
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year + 1, 0, 1));
  return Prisma.sql`AND ${col} >= ${from} AND ${col} < ${to}`;
}
