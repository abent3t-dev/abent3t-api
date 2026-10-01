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

/**
 * G2/G3 (2026-09-28): folio numérico de una PR de Maximo (PR104531 → 104531).
 * Maximo numera las PR en orden, así que el folio ubica en el tiempo a las
 * PR que no traen fecha (AB_CONTRATOS no expone ISSUEDATE; solo la conocemos
 * por las OC que las usan).
 */
export function maximoPrFolio(column: string): Prisma.Sql {
  const col = Prisma.raw(column);
  return Prisma.sql`NULLIF(regexp_replace(${col}, '[^0-9]', '', 'g'), '')::bigint`;
}

/** PRNUM que ya tienen OC: las de las OC vigentes no canceladas (G3). */
export const MAXIMO_PRS_WITH_PO = Prisma.sql`
  SELECT DISTINCT unnest(p.pr_nums) AS prnum
  FROM (${CURRENT_MAXIMO_POS}) p
  WHERE coalesce(p.status, '') NOT IN ('CAN', 'CANCEL')`;

/**
 * G3: condición "la PR (fila de maximo_contracts `alias`) está pendiente de
 * gestionar" = sin contrato y sin OC vigente que la use. Úsala con AND.
 */
export function maximoPrWithoutPo(alias: string): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}.prnum IS NOT NULL AND ${a}.has_contract = false
    AND ${a}.prnum NOT IN (${MAXIMO_PRS_WITH_PO}))`;
}

/**
 * I8 (go-live 2026-09-30): PR DE CONTRATO sin OC vigente. No son carga de
 * Compras: la OC se genera en automático (Ingrid); se muestran aparte.
 */
export function maximoContractPrWithoutPo(alias: string): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}.prnum IS NOT NULL AND ${a}.has_contract = true
    AND ${a}.prnum NOT IN (${MAXIMO_PRS_WITH_PO}))`;
}

/** Ventana de folios [lower, upper) de las PR de Maximo creadas en un periodo. */
export interface MaximoPrFolioWindow {
  lower: bigint | null;
  upper: bigint | null;
}

/**
 * G3: límites de folio para [from, toExcl). Fechas conocidas = ISSUEDATE de
 * la PR más antigua de cada OC con su folio menor. `lower` = primer folio
 * conocido desde `from` (o el siguiente al último anterior); `upper` =
 * primer folio conocido desde `toExcl` (null = abierto: las PR más nuevas
 * todavía no tienen OC y sí cuentan). `lower` null = sin fechas conocidas.
 */
export async function loadMaximoPrFolioWindow(
  prisma: { $queryRaw: <T>(query: Prisma.Sql) => Prisma.PrismaPromise<T> },
  from: Date,
  toExcl: Date | null,
): Promise<MaximoPrFolioWindow> {
  const rows = await prisma.$queryRaw<
    Array<{ lower: bigint | null; upper: bigint | null }>
  >(Prisma.sql`
    WITH known AS (
      SELECT p.pr_issue_date AS d, min(${maximoPrFolio('f.prnum')}) AS folio
      FROM (${CURRENT_MAXIMO_POS}) p, unnest(p.pr_nums) AS f(prnum)
      WHERE p.pr_issue_date IS NOT NULL
      GROUP BY p.ponum, coalesce(p.siteid, ''), p.pr_issue_date
    )
    SELECT coalesce(
             (SELECT min(folio) FROM known WHERE d >= ${from}),
             (SELECT max(folio) + 1 FROM known WHERE d < ${from})
           ) AS lower,
           CASE WHEN ${toExcl}::timestamptz IS NULL THEN NULL
                ELSE (SELECT min(folio) FROM known WHERE d >= ${toExcl}::timestamptz)
           END AS upper`);
  return { lower: rows[0]?.lower ?? null, upper: rows[0]?.upper ?? null };
}

/** `AND` del folio de `alias.prnum` dentro de la ventana (sin ventana → nada). */
export function andMaximoPrInWindow(
  alias: string,
  window: MaximoPrFolioWindow | null,
): Prisma.Sql {
  if (!window) return Prisma.empty;
  if (window.lower === null) return Prisma.sql`AND false`;
  const folio = maximoPrFolio(`${alias}.prnum`);
  return window.upper === null
    ? Prisma.sql`AND ${folio} >= ${window.lower}`
    : Prisma.sql`AND ${folio} >= ${window.lower} AND ${folio} < ${window.upper}`;
}

/** Inicio de la ventana de "pendientes" sin año: hace 12 meses (G3). */
export function pendingWindowStart(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * G7 (2026-09-28): OC de Maximo EN APROBACIÓN = WAPPR, APPRn y APPRnREV
 * (cualquier n; ver common/utils/maximo-status.util.ts). `alias.status`.
 */
export function maximoInApproval(alias: string): Prisma.Sql {
  const col = Prisma.raw(`${alias}.status`);
  return Prisma.sql`(${col} ~ '^(WAPPR|APPR[0-9]+(REV)?)$')`;
}

/**
 * G6: desde cuándo está la OC en su estatus actual = último cambio de su
 * historial POSTATUS (0016); sin historial, el primer WAPPR o la fecha de la OC.
 */
export function maximoStatusSince(alias: string): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`coalesce(
    (SELECT max(h.change_date) FROM maximo_po_status_history h WHERE h.po_id = ${a}.id),
    ${a}.waiting_approval_at, ${a}.created_at_source)`;
}
