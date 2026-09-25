/**
 * E4 (2026-09-25) — Comprador que muestran Expeditación, Órdenes y los
 * reportes. `capturo` = respaldo de SAP: en PRD_ABENT ninguna OC trae
 * comprador (SalesPersonCode = -1), así que se muestra quién la capturó.
 */
export type BuyerKind = 'comprador' | 'capturo' | null;

export function buyerLabel(row: {
  buyer_name: string | null;
  buyer_kind: BuyerKind;
}): string | null {
  if (!row.buyer_name) return null;
  return row.buyer_kind === 'capturo'
    ? `Capturó: ${row.buyer_name}`
    : row.buyer_name;
}

/** Comprador de Maximo: alias de Compras > DISPLAYNAME de Maximo > usuario. */
export function maximoBuyerName(
  code: string | null,
  name: string | null,
  aliases: Map<string, string>,
): string | null {
  if (!code) return null;
  return aliases.get(code) ?? name ?? code;
}
