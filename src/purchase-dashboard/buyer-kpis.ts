import { maximoBuyer, NO_BUYER } from '../common/utils/buyer.util';
import type { Buyer, BuyerKind } from '../common/utils/buyer.util';
import type { CurrencyAmount } from './purchase-dashboard.service';
import {
  MAXIMO_GESTION_APROBACION_DEFINICION,
  MAXIMO_GESTION_DEFINICION,
  maximoGestion,
  maximoGestionDays,
  SAP_GESTION_DEFINICION,
  sapGestionDays,
} from './sap-gestion-days';
import type {
  SapGestionPo,
  SapGestionRequest,
  SapGestionResult,
} from './sap-gestion-days';

/**
 * Bloque M (2026-10-14, Ingrid) — KPIs de Órdenes POR COMPRADOR, "para que
 * los compradores compitan":
 *  - M1: ahorro acumulado por comprador (una barra por persona);
 *  - M2: tiempo de gestión (G2) por comprador, por sistema.
 *
 * Comprador = la regla única E4/F1 (`common/utils/buyer.util.ts`): Maximo (y
 * la OC de SAP que nació allá) = PURCHASEAGENT o, sin él, quien creó la OC
 * (comprador inferido, "Capturó"); SAP propia = quien la capturó. La misma
 * persona se junta entre SAP y Maximo con una llave plegada del nombre
 * (`buyerKey`) y se muestra el nombre del alias de Compras si alguna de sus OC
 * lo trae ("el nombre es el del alias"); si no, la variante con más OC.
 *
 * Funciones puras: las consultas traen los renglones (M1, agrupados por
 * comprador y moneda) o las OC (M2) con su comprador, y aquí se agrupan con
 * la MISMA cuenta de la tarjeta y del tablero: la suma de las barras = el
 * total por construcción.
 */

/** M2: con menos OC en el periodo, el comprador va al final y sin destacar. */
export const MIN_OC_GESTION = 3;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sin espacios de más: así se cuentan las variantes de un nombre. */
const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim();

const byName = (a: string | null, b: string | null) =>
  (a ?? '').localeCompare(b ?? '', 'es');

/**
 * Llave para juntar a la misma persona entre SAP y Maximo: sin espacios de
 * más, minúsculas y sin acentos ("Ingrid Torres GUTIÉRREZ" = "Ingrid Torres
 * Gutiérrez"). null = sin nombre ("Sin comprador identificado").
 */
export function buyerKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = cleanName(name)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  return key === '' ? null : key;
}

/**
 * E4: SAP no registra comprador; el de una OC propia de SAP (o migrada cuyo
 * PONUM no existe en Maximo) es quien la capturó. Misma regla que
 * sap-records (`withRequesters`) y Expeditación (`buyerOf`).
 */
export function sapBuyer(createdByName: string | null): Buyer {
  return createdByName ? { name: createdByName, kind: 'capturo' } : NO_BUYER;
}

/**
 * Comprador de una OC para los KPIs: la regla E4/F1 y si el nombre salió de
 * un alias de Compras → Roles (`alias`), que gana para nombrar la barra.
 */
export type KpiBuyer = Buyer & { alias?: boolean };

/**
 * E4/F1 de una OC de Maximo (o de la OC de SAP que nació allá) para los KPIs:
 * `maximoBuyer` más `alias` = el nombre salió de Compras → Roles (el código
 * que usó la regla, PURCHASEAGENT o, sin él, el creador, tiene alias).
 */
export function maximoKpiBuyer(
  po: {
    purchase_agent?: string | null;
    purchase_agent_name?: string | null;
    created_by?: string | null;
  },
  aliases: Map<string, string>,
): KpiBuyer {
  const code = po.purchase_agent || po.created_by || null;
  return {
    ...maximoBuyer(
      {
        purchase_agent: po.purchase_agent ?? null,
        purchase_agent_name: po.purchase_agent_name ?? null,
        created_by: po.created_by ?? null,
      },
      aliases,
    ),
    alias: code !== null && aliases.has(code),
  };
}

/** Comprador inferido (quien creó o capturó la OC) con nombre. */
const isInferred = (buyer: Buyer) =>
  buyer.kind === 'capturo' && buyerKey(buyer.name) !== null;

export interface BuyerGroup<T> {
  /** null = "Sin comprador identificado". */
  comprador: string | null;
  /** 'capturo' si al menos una de sus OC tiene comprador inferido; null sin comprador. */
  tipo: BuyerKind;
  /** OC del grupo (suma de `weightOf`). */
  documentos: number;
  /** De esas, con comprador inferido. */
  documentos_capturo: number;
  items: T[];
}

/**
 * Agrupa por persona con la llave plegada. Nombre del grupo = el del alias de
 * Compras si alguna OC lo trae; si no (o entre varios), la variante con más
 * OC (empate: la primera en orden alfabético). `weightOf` = OC que representa
 * cada elemento (renglón agrupado en M1; 1 por OC en M2). Los grupos salen en
 * el orden en que aparecen; el orden final lo pone cada KPI.
 */
export function groupByBuyer<T>(
  items: T[],
  buyerOf: (item: T) => KpiBuyer,
  weightOf: (item: T) => number = () => 1,
): BuyerGroup<T>[] {
  const groups = new Map<
    string | null,
    {
      variants: Map<string, { oc: number; alias: boolean }>;
      documentos: number;
      capturo: number;
      items: T[];
    }
  >();
  for (const item of items) {
    const buyer = buyerOf(item);
    const key = buyerKey(buyer.name);
    const weight = weightOf(item);
    const group = groups.get(key) ?? {
      variants: new Map<string, { oc: number; alias: boolean }>(),
      documentos: 0,
      capturo: 0,
      items: [],
    };
    group.items.push(item);
    group.documentos += weight;
    if (key !== null && buyer.name) {
      const variant = cleanName(buyer.name);
      const seen = group.variants.get(variant) ?? { oc: 0, alias: false };
      group.variants.set(variant, {
        oc: seen.oc + weight,
        alias: seen.alias || buyer.alias === true,
      });
      if (buyer.kind === 'capturo') group.capturo += weight;
    }
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, g]) => ({
    comprador:
      key === null
        ? null
        : [...g.variants.entries()].sort(
            ([a, va], [b, vb]) =>
              Number(vb.alias) - Number(va.alias) ||
              vb.oc - va.oc ||
              a.localeCompare(b, 'es'),
          )[0][0],
    tipo: key === null ? null : g.capturo > 0 ? 'capturo' : 'comprador',
    documentos: g.documentos,
    documentos_capturo: g.capturo,
    items: g.items,
  }));
}

/**
 * Suma por moneda, sin convertir (misma moneda se suma, distintas no),
 * redondeada a centavos; de mayor a menor. Moneda sin OC → no aparece.
 */
export function sumByCurrency(
  entries: Array<{ currency: string | null; total: number; count: number }>,
): CurrencyAmount[] {
  const map = new Map<string, CurrencyAmount>();
  for (const e of entries) {
    if (e.count <= 0) continue;
    const key = e.currency ?? 'sin_moneda';
    const acc = map.get(key) ?? { currency: e.currency, total: 0, count: 0 };
    acc.total += e.total;
    acc.count += e.count;
    map.set(key, acc);
  }
  return [...map.values()]
    .map((a) => ({ ...a, total: round2(a.total) }))
    .sort((a, b) => b.total - a.total);
}

// ── M1: ahorro por comprador ───────────────────────────────────────────────

/** M1: un renglón de las consultas de ahorro (agrupadas por comprador y moneda). */
export interface AhorroEntry {
  fuente: 'sap' | 'maximo';
  currency: string | null;
  buyer: KpiBuyer;
  /** Ahorro del renglón, sin convertir. */
  total: number;
  /** OC con ahorro del renglón. */
  count: number;
}

export interface AhorroPorComprador {
  /** null = "Sin comprador identificado". */
  comprador: string | null;
  tipo: BuyerKind;
  /** OC con ahorro. */
  documentos: number;
  /** De esas, con comprador inferido (capturó la OC). */
  documentos_capturo: number;
  /** Ahorro por moneda, sin convertir. */
  por_moneda: CurrencyAmount[];
}

const mxnTotal = (list: CurrencyAmount[]) =>
  list.find((a) => a.currency === 'MXN')?.total ?? 0;

/**
 * M1: ahorro por comprador. Orden: ahorro en MXN de mayor a menor, luego
 * más OC; "Sin comprador identificado" al final.
 */
export function ahorroPorComprador(
  entries: AhorroEntry[],
): AhorroPorComprador[] {
  return groupByBuyer(
    entries,
    (e) => e.buyer,
    (e) => e.count,
  )
    .map((g) => ({
      comprador: g.comprador,
      tipo: g.tipo,
      documentos: g.documentos,
      documentos_capturo: g.documentos_capturo,
      por_moneda: sumByCurrency(g.items),
    }))
    .sort(
      (a, b) =>
        Number(a.comprador === null) - Number(b.comprador === null) ||
        mxnTotal(b.por_moneda) - mxnTotal(a.por_moneda) ||
        b.documentos - a.documentos ||
        byName(a.comprador, b.comprador),
    );
}

/**
 * M1: la tarjeta "Ahorro acumulado" (por moneda y por fuente) y las barras
 * por comprador salen de la MISMA lista de renglones: por moneda, la suma de
 * las barras = el total de la tarjeta (monto y OC).
 */
export function buildAhorro(entries: AhorroEntry[]) {
  const sap = entries.filter((e) => e.fuente === 'sap');
  const maximo = entries.filter((e) => e.fuente === 'maximo');
  const docs = (list: AhorroEntry[]) =>
    list.reduce((sum, e) => sum + e.count, 0);
  return {
    disponible: docs(entries) > 0,
    documentos: docs(entries),
    por_moneda: sumByCurrency(entries),
    por_fuente: {
      sap: { documentos: docs(sap), por_moneda: sumByCurrency(sap) },
      maximo: { documentos: docs(maximo), por_moneda: sumByCurrency(maximo) },
    },
    por_comprador: ahorroPorComprador(entries),
  };
}

// ── M2: tiempo de gestión por comprador ────────────────────────────────────

/** M2: días de un comprador con la misma cuenta de G2 (promedio, mediana y N). */
export interface GestionPorComprador extends SapGestionResult {
  /** null = "Sin comprador identificado". */
  comprador: string | null;
  /** 'capturo' si alguna de sus N OC tiene comprador inferido. */
  tipo: BuyerKind;
  /** De las N, con comprador inferido (quien creó o capturó la OC). */
  documentos_capturo: number;
  /** Solo Maximo: OC sin solicitud (fuera del promedio). */
  sin_solicitud?: number;
  /** Solo Maximo: dato secundario, desde la aprobación de la PR. */
  desde_aprobacion?: {
    promedio_dias: number | null;
    mediana_dias: number | null;
    total: number;
  };
}

/** M2: una OC de SAP de G2 con su comprador. */
export type SapGestionOc = SapGestionPo & { buyer: KpiBuyer };
/** M2: un renglón de `maximoGestionSql` (una OC de Maximo) con su comprador. */
export interface MaximoGestionOc {
  dias: unknown;
  dias_desde_aprobacion: unknown;
  buyer: KpiBuyer;
}

const tipoGestion = (comprador: string | null, capturo: number): BuyerKind =>
  comprador === null ? null : capturo > 0 ? 'capturo' : 'comprador';

/**
 * M2: orden de las barras. Los de N ≥ `minOc` por promedio ascendente (el
 * más rápido arriba); luego los de menos OC; "Sin comprador identificado" al
 * final.
 */
export function sortGestion(
  list: GestionPorComprador[],
  minOc = MIN_OC_GESTION,
): GestionPorComprador[] {
  const rank = (g: GestionPorComprador) =>
    g.comprador === null ? 2 : g.total >= minOc ? 0 : 1;
  const promedio = (g: GestionPorComprador) =>
    g.promedio_dias ?? Number.MAX_VALUE;
  return [...list].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      promedio(a) - promedio(b) ||
      b.total - a.total ||
      byName(a.comprador, b.comprador),
  );
}

/**
 * M2: G2 de SAP por comprador con `sapGestionDays` (la función del tablero)
 * sobre las OC de cada uno: Σ N y Σ días cuadran con el total. Un comprador
 * sin OC en el promedio (N = 0) no sale.
 */
export function sapGestionPorComprador(
  pos: SapGestionOc[],
  requests: SapGestionRequest[],
  minOc = MIN_OC_GESTION,
): GestionPorComprador[] {
  const list = groupByBuyer(pos, (po) => po.buyer).map((g) => {
    const capturo = sapGestionDays(
      g.items.filter((po) => isInferred(po.buyer)),
      requests,
    ).total;
    return {
      comprador: g.comprador,
      tipo: tipoGestion(g.comprador, capturo),
      documentos_capturo: capturo,
      ...sapGestionDays(g.items, requests),
    };
  });
  return sortGestion(
    list.filter((g) => g.total > 0),
    minOc,
  );
}

/**
 * M2: G2 de Maximo por comprador con `maximoGestion` (la función del
 * tablero): desde la creación de la PR (principal, N) y, como dato
 * secundario, desde su aprobación. Un comprador sin OC en el promedio
 * principal (N = 0) no sale; su dato desde la aprobación, si lo tiene, solo
 * cuenta en el total del sistema.
 */
export function maximoGestionPorComprador(
  rows: MaximoGestionOc[],
  minOc = MIN_OC_GESTION,
): GestionPorComprador[] {
  const list = groupByBuyer(rows, (r) => r.buyer).map((g) => {
    const { creacion, desde_aprobacion } = maximoGestion(g.items);
    const capturo = maximoGestionDays(
      g.items.filter((r) => isInferred(r.buyer)),
    ).total;
    return {
      comprador: g.comprador,
      tipo: tipoGestion(g.comprador, capturo),
      documentos_capturo: capturo,
      ...creacion,
      desde_aprobacion: {
        promedio_dias: desde_aprobacion.promedio_dias,
        mediana_dias: desde_aprobacion.mediana_dias,
        total: desde_aprobacion.total,
      },
    };
  });
  return sortGestion(
    list.filter((g) => g.total > 0),
    minOc,
  );
}

/**
 * M2: bloque `gestion_por_comprador` de Órdenes. `total` = el mismo
 * resultado de G2 que el tablero (`summary.dias_gestion`) para las mismas OC;
 * las definiciones son las del tablero.
 */
export function buildGestionPorComprador(
  sap: { pos: SapGestionOc[]; requests: SapGestionRequest[] },
  maximo: MaximoGestionOc[],
  minOc = MIN_OC_GESTION,
) {
  const maximoTotal = maximoGestion(maximo);
  return {
    min_oc: minOc,
    sap: {
      definicion: SAP_GESTION_DEFINICION,
      total: sapGestionDays(sap.pos, sap.requests),
      compradores: sapGestionPorComprador(sap.pos, sap.requests, minOc),
    },
    maximo: {
      definicion: MAXIMO_GESTION_DEFINICION,
      definicion_secundaria: MAXIMO_GESTION_APROBACION_DEFINICION,
      total: maximoTotal.creacion,
      total_desde_aprobacion: maximoTotal.desde_aprobacion,
      compradores: maximoGestionPorComprador(maximo, minOc),
    },
  };
}
