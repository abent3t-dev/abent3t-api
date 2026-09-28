/**
 * G1 (reunión con Ingrid 2026-09-28) — Proveedor EFECTIVO de las OC de Maximo.
 *
 * Diagnóstico en prod: los códigos de proveedor de Maximo (P0000xxx) NO son
 * los de SAP aunque se parecen, y varios nombres del maestro de Maximo se
 * copiaron de SAP por código. Ejemplo: en Maximo P0000440 se llama
 * "ASOCIACION MEXICANA DE ENERGIA", pero sus OC migradas a SAP quedaron a
 * nombre de P0000219 NAES ENERGIA S DE RL DE CV (122 + 5 OC). El top de
 * Maximo mostraba "Asociación" con 54 M que en realidad son de NAES.
 *
 * Regla, en este orden:
 *  (a) la OC ya migró a SAP (`sap_purchase_orders.maximo_ponum = ponum`):
 *      el proveedor de ESA OC en SAP ("según SAP"): su código y el nombre
 *      actual del maestro de SAP (el de la OC si no está en el maestro), para
 *      que las variantes ("NAES ENERGIA" / "NAES ENERGIA S DE RL DE CV") no
 *      se partan en dos en filtros y tops;
 *  (b) si no, cruce por código: entre las OC migradas de ese `vendor_id` de
 *      Maximo, el `card_code` de SAP que cubre al menos el 90% (mínimo 2
 *      OC), con su nombre actual de `sap_business_partners` ("según SAP");
 *  (c) si no, el `vendor_id` / `vendor_name` de Maximo ("según Maximo").
 *
 * La llave de agrupación lleva el sistema (`sap:P0000219`, `maximo:P0000440`)
 * porque los dos maestros son espacios de códigos distintos.
 *
 * Funciones puras (sin BD): el servicio carga los pares y las usa todas las
 * lecturas (Órdenes, Contratos, Expeditación, Reportes y el export de nombres
 * distintos), así que la regla vive en un solo lugar.
 */

export const XREF_MIN_COVERAGE = 0.9;
export const XREF_MIN_ORDERS = 2;

export type VendorSource = 'sap_oc' | 'sap_cruce' | 'maximo';

/** OC vigente de Maximo que migró a SAP, con el proveedor de su OC en SAP. */
export interface MigratedPair {
  ponum: string;
  vendor_id: string | null;
  vendor_name: string | null;
  card_code: string;
  card_name: string | null;
}

export interface XrefCode {
  card_code: string;
  /** Nombre en SAP: maestro de proveedores o, si no está, el de sus OC. */
  card_name: string | null;
  count: number;
  /** Participación entre las OC migradas del proveedor de Maximo (0–1). */
  share: number;
}

export interface VendorXrefEntry {
  vendor_id: string;
  /** Nombre en el maestro de Maximo (el más frecuente en sus OC). */
  vendor_name: string | null;
  /** OC migradas a SAP de ese proveedor de Maximo. */
  migrated: number;
  /** Proveedores de SAP en los que cayeron, de mayor a menor. */
  codes: XrefCode[];
  /** Regla (b): el que cubre ≥ 90% con al menos 2 OC; null si no hay. */
  dominant: XrefCode | null;
  /** Sin dominante y repartido en 2 o más proveedores de SAP. */
  ambiguous: boolean;
}

export interface MaximoVendorXref {
  byPonum: Map<string, { card_code: string; card_name: string | null }>;
  byVendor: Map<string, VendorXrefEntry>;
  /** Nombre actual de cada card_code en el maestro de SAP. */
  bpNames: Map<string, string>;
}

export const EMPTY_XREF: MaximoVendorXref = {
  byPonum: new Map(),
  byVendor: new Map(),
  bpNames: new Map(),
};

function mostFrequent(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && best !== null && value < best)
    ) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export function buildVendorXref(
  pairs: MigratedPair[],
  bpNames: Map<string, string>,
): MaximoVendorXref {
  const byPonum = new Map<
    string,
    { card_code: string; card_name: string | null }
  >();
  const perVendor = new Map<string, MigratedPair[]>();
  for (const pair of pairs) {
    if (byPonum.has(pair.ponum)) continue; // misma OC en dos sitios: una vez
    byPonum.set(pair.ponum, {
      card_code: pair.card_code,
      card_name: pair.card_name,
    });
    if (!pair.vendor_id) continue;
    const list = perVendor.get(pair.vendor_id) ?? [];
    list.push(pair);
    perVendor.set(pair.vendor_id, list);
  }

  const byVendor = new Map<string, VendorXrefEntry>();
  for (const [vendorId, list] of perVendor) {
    const perCode = new Map<string, MigratedPair[]>();
    for (const pair of list) {
      const group = perCode.get(pair.card_code) ?? [];
      group.push(pair);
      perCode.set(pair.card_code, group);
    }
    const codes: XrefCode[] = [...perCode.entries()]
      .map(([cardCode, group]) => ({
        card_code: cardCode,
        card_name:
          bpNames.get(cardCode) ?? mostFrequent(group.map((p) => p.card_name)),
        count: group.length,
        share: group.length / list.length,
      }))
      .sort(
        (a, b) => b.count - a.count || a.card_code.localeCompare(b.card_code),
      );
    const top = codes[0];
    const dominant =
      top && list.length >= XREF_MIN_ORDERS && top.share >= XREF_MIN_COVERAGE
        ? top
        : null;
    byVendor.set(vendorId, {
      vendor_id: vendorId,
      vendor_name: mostFrequent(list.map((p) => p.vendor_name)),
      migrated: list.length,
      codes,
      dominant,
      ambiguous: dominant === null && codes.length >= 2,
    });
  }
  return { byPonum, byVendor, bpNames };
}

export interface EffectiveVendor {
  /** Llave de agrupación con el sistema (`sap:…` / `maximo:…`); null = sin proveedor. */
  key: string | null;
  code: string | null;
  name: string | null;
  source: VendorSource | null;
  /** Lo que dice el maestro de Maximo (se conserva para mostrarlo). */
  maximo_code: string | null;
  maximo_name: string | null;
  /** El nombre efectivo no es el de Maximo → "en Maximo: …" en secundario. */
  differs: boolean;
}

// Formas jurídicas y sus pedazos ("S.A. DE C.V." → S A DE C V): se quitan del
// final para comparar nombres ("GALIPER INDUSTRIAL" = "GALIPER INDUSTRIAL SA DE CV").
const LEGAL_TOKENS = new Set([
  'S',
  'A',
  'P',
  'I',
  'B',
  'C',
  'V',
  'R',
  'L',
  'DE',
  'SA',
  'SAPI',
  'SAB',
  'CV',
  'RL',
  'SC',
  'SRL',
  'SPR',
  'SAS',
  'INC',
  'LLC',
  'LTD',
  'CO',
  'CORP',
]);

/** Nombre comparable: mayúsculas, sin acentos ni signos, sin forma jurídica. */
export function normalizeCompanyName(name: string | null | undefined): string {
  if (!name) return '';
  const tokens = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_TOKENS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(' ');
}

export function sameCompanyName(a: string | null, b: string | null): boolean {
  return normalizeCompanyName(a) === normalizeCompanyName(b);
}

export function effectiveMaximoVendor(
  po: {
    ponum?: string | null;
    vendor_id: string | null;
    vendor_name: string | null;
  },
  xref: MaximoVendorXref,
): EffectiveVendor {
  const maximo = { maximo_code: po.vendor_id, maximo_name: po.vendor_name };
  const fromSap = (
    code: string,
    name: string | null,
    source: VendorSource,
  ): EffectiveVendor => ({
    key: `sap:${code}`,
    code,
    name,
    source,
    ...maximo,
    differs:
      po.vendor_name !== null &&
      name !== null &&
      !sameCompanyName(name, po.vendor_name),
  });

  // (a) la OC migró a SAP: el proveedor de esa OC
  const migrated = po.ponum ? xref.byPonum.get(po.ponum) : undefined;
  if (migrated) {
    return fromSap(
      migrated.card_code,
      xref.bpNames.get(migrated.card_code) ?? migrated.card_name,
      'sap_oc',
    );
  }
  // (b) cruce por código del proveedor de Maximo
  const entry = po.vendor_id ? xref.byVendor.get(po.vendor_id) : undefined;
  if (entry?.dominant) {
    return fromSap(
      entry.dominant.card_code,
      entry.dominant.card_name,
      'sap_cruce',
    );
  }
  // (c) lo que dice Maximo
  if (!po.vendor_id && !po.vendor_name) {
    return {
      key: null,
      code: null,
      name: null,
      source: null,
      ...maximo,
      differs: false,
    };
  }
  return {
    key: `maximo:${po.vendor_id ?? po.vendor_name}`,
    code: po.vendor_id,
    name: po.vendor_name,
    source: 'maximo',
    ...maximo,
    differs: false,
  };
}

/** Texto secundario "en Maximo: NOMBRE (CÓDIGO)" cuando el nombre difiere. */
export function maximoVendorNote(vendor: EffectiveVendor): string | null {
  if (!vendor.differs) return null;
  const code = vendor.maximo_code ? ` (${vendor.maximo_code})` : '';
  return `en Maximo: ${vendor.maximo_name ?? 'sin nombre'}${code}`;
}

export const VENDOR_SOURCE_LABELS: Record<VendorSource, string> = {
  sap_oc: 'según SAP (la OC migró a SAP)',
  sap_cruce: 'según SAP (cruce por código)',
  maximo: 'según Maximo',
};

// ── Lista para corregir el maestro de Maximo (export G1.3) ────────────────

export type MismatchKind = 'nombre_distinto' | 'ambiguo' | 'una_oc';

export const MISMATCH_LABELS: Record<MismatchKind, string> = {
  nombre_distinto: 'Nombre distinto',
  ambiguo: 'Ambiguo (cae en varios proveedores de SAP)',
  una_oc: 'Nombre distinto (una sola OC migrada)',
};

export interface VendorMismatchRow {
  kind: MismatchKind;
  maximo_code: string;
  maximo_name: string | null;
  sap_code: string;
  sap_name: string | null;
  /** OC migradas de este par (código Maximo → código SAP). */
  migrated: number;
  /** OC migradas del proveedor de Maximo (todas sus parejas). */
  migrated_total: number;
  /** % de las OC migradas del proveedor de Maximo que cayeron en este código de SAP. */
  coverage_pct: number;
}

/**
 * Proveedores de Maximo cuyo nombre no es el de SAP (con cruce dominante o
 * con una sola OC migrada) y los ambiguos (una fila por código de SAP).
 */
export function vendorMismatchRows(
  xref: MaximoVendorXref,
): VendorMismatchRow[] {
  const rows: VendorMismatchRow[] = [];
  for (const entry of xref.byVendor.values()) {
    const base = {
      maximo_code: entry.vendor_id,
      maximo_name: entry.vendor_name,
      migrated_total: entry.migrated,
    };
    const toRow = (kind: MismatchKind, code: XrefCode): VendorMismatchRow => ({
      ...base,
      kind,
      sap_code: code.card_code,
      sap_name: code.card_name,
      migrated: code.count,
      coverage_pct: Math.round(code.share * 1000) / 10,
    });
    if (entry.ambiguous) {
      for (const code of entry.codes) rows.push(toRow('ambiguo', code));
      continue;
    }
    const code =
      entry.dominant ?? (entry.migrated === 1 ? entry.codes[0] : null);
    if (!code || sameCompanyName(code.card_name, entry.vendor_name)) continue;
    rows.push(toRow(entry.dominant ? 'nombre_distinto' : 'una_oc', code));
  }
  const order: Record<MismatchKind, number> = {
    nombre_distinto: 0,
    ambiguo: 1,
    una_oc: 2,
  };
  return rows.sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      b.migrated_total - a.migrated_total ||
      a.maximo_code.localeCompare(b.maximo_code) ||
      b.migrated - a.migrated,
  );
}

export interface VendorMismatchSummary {
  /** Códigos de Maximo con al menos una OC migrada a SAP. */
  codigos_con_migradas: number;
  /** Con cruce dominante y nombre distinto al de SAP. */
  nombre_distinto: number;
  /** Repartidos entre varios proveedores de SAP sin dominante. */
  ambiguos: number;
  /** Una sola OC migrada y el nombre de SAP es otro. */
  una_oc: number;
}

export function vendorMismatchSummary(
  xref: MaximoVendorXref,
): VendorMismatchSummary {
  const rows = vendorMismatchRows(xref);
  const codes = (kind: MismatchKind) =>
    new Set(rows.filter((r) => r.kind === kind).map((r) => r.maximo_code)).size;
  return {
    codigos_con_migradas: xref.byVendor.size,
    nombre_distinto: codes('nombre_distinto'),
    ambiguos: codes('ambiguo'),
    una_oc: codes('una_oc'),
  };
}
