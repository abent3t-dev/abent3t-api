import {
  effectiveMaximoVendor,
  MaximoVendorXref,
  normalizeCompanyName,
} from '../erp-vendors/maximo-vendor-xref';

/**
 * G1 (2026-09-28) — Tops de proveedores de Reportes:
 *  - SAP: por `card_code` (las variantes de nombre de un mismo código se
 *    juntan) con el nombre del maestro de SAP;
 *  - Maximo: por proveedor EFECTIVO (ver erp-vendors/maximo-vendor-xref);
 *  - SAP + Maximo contado una vez (D1): las OC de SAP sin las migradas que
 *    existen en Maximo + las de Maximo por proveedor efectivo.
 * Siempre por (proveedor, moneda): nunca se suman monedas. Funciones puras.
 */

export const VENDOR_TOP_LIMIT = 10;

export interface VendorAmount {
  /** `sap:P0000219` / `maximo:P0000440` (los maestros son espacios distintos). */
  key: string;
  code: string | null;
  name: string | null;
  currency: string | null;
  count: number;
  monto: number;
  source: 'sap' | 'maximo';
  /** Maximo: lo que dice su maestro (para "en Maximo: …"). */
  maximo_code?: string | null;
  maximo_name?: string | null;
}

export interface VendorTopRow {
  key: string;
  /** Sistema del código (`sap` / `maximo`): el top sabe a qué pestaña ir. */
  sistema: 'sap' | 'maximo';
  codigo: string | null;
  proveedor: string;
  currency: string | null;
  count: number;
  monto: number;
  /** "en Maximo: NOMBRE (CÓDIGO)" cuando Maximo lo nombra distinto. */
  nota: string | null;
  por_fuente: {
    sap: { count: number; monto: number };
    maximo: { count: number; monto: number };
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function mostFrequent(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** OC vigentes de Maximo → montos por proveedor efectivo. */
export function maximoVendorAmounts(
  rows: Array<{
    ponum: string;
    vendor_id: string | null;
    vendor_name: string | null;
    currency: string | null;
    total_cost: unknown;
  }>,
  xref: MaximoVendorXref,
): VendorAmount[] {
  return rows.flatMap((row) => {
    const vendor = effectiveMaximoVendor(row, xref);
    if (!vendor.key) return [];
    return [
      {
        key: vendor.key,
        code: vendor.code,
        name: vendor.name,
        currency: row.currency,
        count: 1,
        monto: Number(row.total_cost ?? 0),
        source: 'maximo' as const,
        maximo_code: row.vendor_id,
        maximo_name: row.vendor_name,
      },
    ];
  });
}

/**
 * Agrupa por (llave, moneda) y devuelve los `limit` de mayor monto. El
 * nombre de un código de SAP es el de su maestro (`bpNames`) o el más usado.
 */
export function rankVendors(
  amounts: VendorAmount[],
  bpNames: Map<string, string>,
  limit = VENDOR_TOP_LIMIT,
): VendorTopRow[] {
  const groups = new Map<string, VendorAmount[]>();
  for (const a of amounts) {
    const id = `${a.key}|${a.currency ?? ''}`;
    groups.set(id, [...(groups.get(id) ?? []), a]);
  }
  const rows: VendorTopRow[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    const sistema = first.key.startsWith('sap:') ? 'sap' : 'maximo';
    const name =
      (sistema === 'sap' && first.code ? bpNames.get(first.code) : undefined) ??
      mostFrequent(list.map((a) => a.name).filter((n): n is string => !!n)) ??
      first.code ??
      'Sin proveedor';
    const differentMaximo = new Map<string, string>();
    for (const a of list) {
      if (a.source !== 'maximo' || !a.maximo_name) continue;
      if (normalizeCompanyName(a.maximo_name) === normalizeCompanyName(name))
        continue;
      differentMaximo.set(
        `${a.maximo_code ?? ''}|${a.maximo_name}`,
        `${a.maximo_name}${a.maximo_code ? ` (${a.maximo_code})` : ''}`,
      );
    }
    const notes = [...differentMaximo.values()];
    const bySource = (source: 'sap' | 'maximo') => {
      const part = list.filter((a) => a.source === source);
      return {
        count: part.reduce((s, a) => s + a.count, 0),
        monto: round2(part.reduce((s, a) => s + a.monto, 0)),
      };
    };
    const sap = bySource('sap');
    const maximo = bySource('maximo');
    rows.push({
      key: first.key,
      sistema,
      codigo: first.code,
      proveedor: name,
      currency: first.currency,
      count: sap.count + maximo.count,
      monto: round2(sap.monto + maximo.monto),
      nota:
        notes.length === 0
          ? null
          : `en Maximo: ${notes.slice(0, 2).join(' · ')}${notes.length > 2 ? ` y ${notes.length - 2} más` : ''}`,
      por_fuente: { sap, maximo },
    });
  }
  return rows
    .sort((a, b) => b.monto - a.monto || a.proveedor.localeCompare(b.proveedor))
    .slice(0, limit);
}
