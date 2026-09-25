/**
 * E4 (2026-09-25) — Comprador que muestran Expeditación, Órdenes y los
 * reportes. `capturo` = respaldo cuando el ERP no registra comprador: en
 * SAP (ninguna OC de PRD trae SalesPersonCode) es quien capturó la OC; en
 * Maximo (F1: solo 11 de 5,008 OC traen PURCHASEAGENT) es quien la creó,
 * el CHANGEBY del primer estatus.
 */
export type BuyerKind = 'comprador' | 'capturo' | null;

export interface Buyer {
  name: string | null;
  kind: BuyerKind;
}

export const NO_BUYER: Buyer = { name: null, kind: null };

/** Texto a mostrar: el nombre, o "Capturó: …" si es el respaldo. */
export function buyerText(buyer: Buyer): string | null {
  if (!buyer.name) return null;
  return buyer.kind === 'capturo' ? `Capturó: ${buyer.name}` : buyer.name;
}

export function buyerLabel(row: {
  buyer_name: string | null;
  buyer_kind: BuyerKind;
}): string | null {
  return buyerText({ name: row.buyer_name, kind: row.buyer_kind });
}

/**
 * Comprador de una OC de Maximo: PURCHASEAGENT (alias de Compras >
 * DISPLAYNAME de Maximo > usuario) o, sin él, quien la creó (alias >
 * usuario) como "Capturó". Nunca el usuario de la integración de SAP.
 */
export function maximoBuyer(
  po: {
    purchase_agent: string | null;
    purchase_agent_name: string | null;
    created_by: string | null;
  },
  aliases: Map<string, string>,
): Buyer {
  if (po.purchase_agent) {
    return {
      name:
        aliases.get(po.purchase_agent) ??
        po.purchase_agent_name ??
        po.purchase_agent,
      kind: 'comprador',
    };
  }
  if (po.created_by) {
    return {
      name: aliases.get(po.created_by) ?? po.created_by,
      kind: 'capturo',
    };
  }
  return NO_BUYER;
}
