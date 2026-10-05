import {
  effectiveMaximoVendor,
  MaximoVendorXref,
  normalizeCompanyName,
} from '../erp-vendors/maximo-vendor-xref';
import { TABLERO_MONTO_BASE } from '../common/sql/erp-views.sql';
import type { MontoBase } from '../common/sql/erp-views.sql';

/**
 * G1 (2026-09-28) — Tops de proveedores de Reportes:
 *  - SAP: por `card_code` (las variantes de nombre de un mismo código se
 *    juntan) con el nombre del maestro de SAP;
 *  - Maximo: por proveedor EFECTIVO (ver erp-vendors/maximo-vendor-xref);
 *  - SAP + Maximo contado una vez (D1): las OC de SAP sin las migradas que
 *    existen en Maximo + las de Maximo por proveedor efectivo.
 * Siempre por (proveedor, moneda): nunca se suman monedas. Funciones puras.
 *
 * K6 (2026-10-05): `monto` va en la base de `TABLERO_MONTO_BASE` (con IVA
 * hasta que conteste Ingrid) y cada fila trae el subtotal sin IVA y las OC
 * sin él como dato secundario. El orden del top sigue siendo por `monto`.
 */

export const VENDOR_TOP_LIMIT = 10;

export interface VendorAmount {
  /** `sap:P0000219` / `maximo:P0000440` (los maestros son espacios distintos). */
  key: string;
  code: string | null;
  name: string | null;
  currency: string | null;
  count: number;
  /** En la base de `TABLERO_MONTO_BASE` (K6). */
  monto: number;
  /** K6: sin IVA, de las OC que tienen subtotal; `sin_subtotal` = las que no. */
  subtotal: number;
  sin_subtotal: number;
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
  /** K6: dato secundario sin IVA y OC sin subtotal. */
  subtotal: number;
  sin_subtotal: number;
  /** "en Maximo: NOMBRE (CÓDIGO)" cuando Maximo lo nombra distinto. */
  nota: string | null;
  por_fuente: {
    sap: VendorSourceAmount;
    maximo: VendorSourceAmount;
  };
}

export interface VendorSourceAmount {
  count: number;
  monto: number;
  subtotal: number;
  sin_subtotal: number;
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

/**
 * OC vigentes de Maximo → montos por proveedor efectivo. K6: `monto` en la
 * base pedida (TOTALCOST con IVA o el `subtotal` sin IVA); sin subtotal, la
 * OC no suma a la base sin IVA y cuenta en `sin_subtotal` (no se estima).
 */
export function maximoVendorAmounts(
  rows: Array<{
    ponum: string;
    vendor_id: string | null;
    vendor_name: string | null;
    currency: string | null;
    total_cost: unknown;
    subtotal?: unknown;
  }>,
  xref: MaximoVendorXref,
  base: MontoBase = TABLERO_MONTO_BASE,
): VendorAmount[] {
  return rows.flatMap((row) => {
    const vendor = effectiveMaximoVendor(row, xref);
    if (!vendor.key) return [];
    const subtotal =
      row.subtotal === null || row.subtotal === undefined
        ? null
        : Number(row.subtotal);
    return [
      {
        key: vendor.key,
        code: vendor.code,
        name: vendor.name,
        currency: row.currency,
        count: 1,
        monto:
          base === 'sin_iva' ? (subtotal ?? 0) : Number(row.total_cost ?? 0),
        subtotal: subtotal ?? 0,
        sin_subtotal: subtotal === null ? 1 : 0,
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
    const bySource = (source: 'sap' | 'maximo'): VendorSourceAmount => {
      const part = list.filter((a) => a.source === source);
      return {
        count: part.reduce((s, a) => s + a.count, 0),
        monto: round2(part.reduce((s, a) => s + a.monto, 0)),
        subtotal: round2(part.reduce((s, a) => s + a.subtotal, 0)),
        sin_subtotal: part.reduce((s, a) => s + a.sin_subtotal, 0),
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
      subtotal: round2(sap.subtotal + maximo.subtotal),
      sin_subtotal: sap.sin_subtotal + maximo.sin_subtotal,
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
