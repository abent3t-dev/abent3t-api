import { maximoBuyer, NO_BUYER } from '../common/utils/buyer.util';
import type { Buyer, BuyerKind } from '../common/utils/buyer.util';
import type { CurrencyAmount } from './purchase-dashboard.service';
import {
  averageAndMedian,
  MAXIMO_GESTION_APROBACION_DEFINICION,
  MAXIMO_GESTION_DEFINICION,
  maximoGestion,
  maximoGestionDays,
  maximoGestionValues,
  SAP_GESTION_DEFINICION,
  sapGestionDays,
  sapGestionValues,
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
 *
 * Bloque N (2026-10-16, Ingrid):
 *  - N1: por persona, el monto adjudicado (OC sin IVA) junto al ahorro.
 *  - N2: gestiones por persona con "Ambos" sistemas: la N es la suma y el
 *    promedio y la mediana salen de los días de cada OC.
 *  - La persona se junta entre SAP y Maximo por su perfil de la plataforma
 *    cuando lo hay (alias de Maximo ligado al perfil en Compras → Roles, o un
 *    nombre igual al del perfil) y se nombra como el perfil; si no, por la
 *    llave plegada del nombre, como en M.
 *
 * Bloque O3 (2026-10-26, Ingrid: "solo debería salir Ana, Jorge, Diana y
 * yo"; regla con CIISA el 23-oct) — en N1, N2 y M1 solo personas
 * compradoras y dos grupos en gris al final:
 *  - "OC de contrato" (`grupo='contrato'`): la OC de Maximo con
 *    CONTRACTREFNUM (`maximoPoDeContrato`), la misma marca que los montos del
 *    avance (O1); no se le atribuye a quien la capturó;
 *  - "Sin comprador identificado" (`grupo='sin_comprador'`).
 * Maximo (y la OC de SAP que nació allá): comprador de la RQ (RFQSTATUS,
 * `maximoRqBuyerJoin`) › agente de compras (PURCHASEAGENT) › sin comprador;
 * "Capturó" ya no cuenta como comprador. SAP (no tiene RQ): quien capturó
 * la OC si está marcado como comprador (`COMPRADORES_SAP`); si no, sin
 * comprador. Las tablas (Órdenes, Expeditación) siguen diciendo "Capturó".
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
 * un alias de Compras → Roles (`alias`), que gana para nombrar la barra. N:
 * `profileId`/`profileName` = el perfil de la plataforma de esa persona, si
 * se pudo ligar (junta y nombra el grupo).
 */
export type KpiBuyer = Buyer & {
  alias?: boolean;
  profileId?: string | null;
  profileName?: string | null;
  /** O3: la OC es de contrato y va a su grupo, sin persona. */
  grupo?: 'contrato';
};

/**
 * O3: a qué grupo va cada renglón de los KPIs por persona: una persona
 * compradora, "Sin comprador identificado" o "OC de contrato" (los dos
 * últimos en gris y al final, en ese orden).
 */
export type GrupoComprador = 'persona' | 'sin_comprador' | 'contrato';

const ORDEN_GRUPO: Record<GrupoComprador, number> = {
  persona: 0,
  sin_comprador: 1,
  contrato: 2,
};

/** O3: comprador de una OC de contrato (su grupo, sin persona). */
export const OC_DE_CONTRATO: KpiBuyer = {
  name: null,
  kind: null,
  grupo: 'contrato',
};

/** O3: llave del grupo de contrato (`personKey`); no choca con un nombre. */
const CONTRATO_KEY = 'grupo:contrato';

/**
 * O3 (2026-10-26): desde cuándo vale el comprador de las gráficas: la RQ de
 * Maximo trae al comprador en las OC de 2026 (480 de 483 sin contrato) e
 * Ingrid pidió acotar las gráficas a 2026.
 */
export const COMPRADOR_DESDE_ANIO = 2026;

/** "Ingrid, Diana, Jorge y Ana": los nombres de pila de la marca de SAP. */
export function compradoresSapTexto(): string {
  const nombres = COMPRADORES_SAP.map((c) => c.nombre.split(' ')[0]);
  return nombres.length <= 1
    ? nombres.join('')
    : `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
}

/**
 * O3: aviso para "Todos" o un año anterior a 2026; null desde 2026. En
 * Maximo, las OC de antes casi no traen RQ; en SAP, la marca es la lista de
 * hoy y quien capturaba antes (p. ej. Laura Montaño) no está en ella.
 */
export function compradorAviso(year: number | null): string | null {
  if (year !== null && year >= COMPRADOR_DESDE_ANIO) return null;
  return `El comprador se registra desde ${COMPRADOR_DESDE_ANIO}. En Maximo sale de la solicitud de cotización (RQ), que las OC de antes casi no traen; en SAP solo cuentan quienes hoy son compradores (${compradoresSapTexto()}). Por eso, ${
    year === null ? 'con "Todos"' : `en ${year}`
  }, muchas OC van a "Sin comprador identificado".`;
}

/**
 * O3 (2026-10-26): quién es comprador en SAP, por su nombre en SAP (y su
 * usuario de Maximo, para ligarlo por el perfil). Va en una constante
 * mientras no exista la marca "Es comprador" en Compras → Roles: sería una
 * columna nueva (migración 0022). Se compara sin acentos ni mayúsculas
 * ("Ingrid Torres GUTIÉRREZ" de SAP = "Ingrid Torres Gutiérrez").
 */
export const COMPRADORES_SAP: ReadonlyArray<{
  nombre: string;
  maximo: string;
}> = [
  { nombre: 'Ingrid Torres Gutiérrez', maximo: 'IVTOG' },
  { nombre: 'Diana Yohara Méndez', maximo: 'DYMP1' },
  { nombre: 'Jorge González', maximo: 'JAGS1' },
  { nombre: 'Ana Daniela Contreras Sánchez', maximo: 'ADCS1' },
];

/** O3: a quién marca `COMPRADORES_SAP`: nombres plegados y perfiles ligados. */
export interface BuyerMark {
  keys: Set<string>;
  profiles: Set<string>;
}

/**
 * O3: la marca con el directorio de personas de N2: además del nombre, el
 * perfil al que liga cada comprador (por su usuario de Maximo o por su
 * nombre), para que valga en los dos sistemas aunque SAP lo escriba distinto.
 */
export function buildBuyerMark(
  dir: PersonDirectory = EMPTY_DIRECTORY,
  compradores = COMPRADORES_SAP,
): BuyerMark {
  const keys = new Set<string>();
  const profiles = new Set<string>();
  for (const c of compradores) {
    const key = buyerKey(c.nombre);
    if (key) keys.add(key);
    const profile =
      dir.aliasProfile.get(c.maximo.trim().toLowerCase()) ??
      (key ? dir.aliasNameProfile.get(key) : undefined) ??
      (key ? dir.profileByName.get(key) : undefined);
    if (profile) profiles.add(profile);
  }
  return { keys, profiles };
}

/** O3: la persona está marcada como compradora (por nombre o por perfil). */
export function isMarkedBuyer(buyer: KpiBuyer, mark: BuyerMark): boolean {
  const key = buyerKey(buyer.name);
  return (
    (key !== null && mark.keys.has(key)) ||
    (!!buyer.profileId && mark.profiles.has(buyer.profileId))
  );
}

/**
 * N2 (2026-10-16): con quién ligar a cada persona.
 *  - `aliasProfile`: código de Maximo (minúsculas) → perfil ligado a su alias;
 *  - `aliasNameProfile`: nombre plegado de un alias ligado → su perfil (así
 *    el usuario de SAP que se llama como el alias cae en el mismo perfil
 *    aunque el perfil tenga otro nombre);
 *  - `profileByName`: nombre plegado → perfil activo.
 * En las dos últimas, un nombre que lleva a dos perfiles no liga (no se
 * adivina). `profileName` trae también los perfiles inactivos ligados.
 */
export interface PersonDirectory {
  aliasProfile: Map<string, string>;
  aliasNameProfile: Map<string, string>;
  profileByName: Map<string, string>;
  profileName: Map<string, string | null>;
}

export const EMPTY_DIRECTORY: PersonDirectory = {
  aliasProfile: new Map(),
  aliasNameProfile: new Map(),
  profileByName: new Map(),
  profileName: new Map(),
};

/** nombre plegado → perfil, solo donde el nombre lleva a uno solo. */
function uniqueByName(pairs: Array<[string | null, string]>) {
  const byName = new Map<string, Set<string>>();
  for (const [name, id] of pairs) {
    const key = buyerKey(name);
    if (key) byName.set(key, (byName.get(key) ?? new Set()).add(id));
  }
  const unique = new Map<string, string>();
  for (const [key, ids] of byName) {
    if (ids.size === 1) unique.set(key, [...ids][0]);
  }
  return unique;
}

export function buildPersonDirectory(
  aliases: Iterable<{
    code: string;
    display_name?: string | null;
    profile_id: string | null;
  }>,
  profiles: Array<{
    id: string;
    full_name: string | null;
    is_active?: boolean;
  }>,
): PersonDirectory {
  const aliasProfile = new Map<string, string>();
  const aliasNames: Array<[string | null, string]> = [];
  for (const a of aliases) {
    if (!a.profile_id) continue;
    aliasProfile.set(a.code.trim().toLowerCase(), a.profile_id);
    aliasNames.push([a.display_name ?? null, a.profile_id]);
  }
  const profileName = new Map<string, string | null>();
  for (const p of profiles) profileName.set(p.id, p.full_name);
  return {
    aliasProfile,
    aliasNameProfile: uniqueByName(aliasNames),
    // por nombre solo los perfiles activos; los inactivos ligan por su alias
    profileByName: uniqueByName(
      profiles
        .filter((p) => p.is_active !== false)
        .map((p): [string | null, string] => [p.full_name, p.id]),
    ),
    profileName,
  };
}

/** N2: liga el comprador a su perfil (por el alias del código o por su nombre). */
function linkProfile(
  buyer: KpiBuyer,
  code: string | null,
  dir: PersonDirectory,
): KpiBuyer {
  const key = buyerKey(buyer.name);
  const profileId =
    (code ? dir.aliasProfile.get(code.trim().toLowerCase()) : undefined) ??
    (key ? dir.aliasNameProfile.get(key) : undefined) ??
    (key ? dir.profileByName.get(key) : undefined);
  if (!profileId) return buyer;
  return {
    ...buyer,
    profileId,
    profileName: dir.profileName.get(profileId) ?? null,
  };
}

/**
 * N1 (2026-10-16): usuarios de SAP que son la integración con Maximo, no
 * personas. Nunca son el comprador (E4/F1): su OC, si su PO no está en el
 * staging de Maximo (de donde saldría el comprador), va a "Sin comprador
 * identificado" en los KPIs por persona. (Expeditación y los listados siguen
 * diciendo "Capturó: …", que es un dato del documento.)
 */
export const SAP_INTEGRATION_USERS = ['FAVOR DE NO TOCAR USUARIO PP XAMAI'];

/**
 * N (2026-10-16): usuarios de sistema de Maximo (el código, no el nombre).
 * Una OC que creó el sistema (p. ej. la automática de un contrato) y no trae
 * PURCHASEAGENT no tiene comprador: va a "Sin comprador identificado" en los
 * KPIs por persona, como la del usuario de la integración de SAP.
 */
export const MAXIMO_SYSTEM_USERS = ['MAXADMIN', 'MAXREG'];

const isMaximoSystemUser = (code: string | null) =>
  code !== null && MAXIMO_SYSTEM_USERS.includes(code.trim().toUpperCase());

/**
 * E4 con el perfil (N2): quien capturó la OC de SAP, ligado por su nombre.
 * O3: con `mark`, solo si está marcado como comprador (`COMPRADORES_SAP`);
 * si no, "Sin comprador identificado". Sin `mark`, como en N.
 */
export function sapKpiBuyer(
  createdByName: string | null,
  dir: PersonDirectory = EMPTY_DIRECTORY,
  mark?: BuyerMark,
): KpiBuyer {
  const key = buyerKey(createdByName);
  if (key && SAP_INTEGRATION_USERS.some((u) => buyerKey(u) === key)) {
    return NO_BUYER;
  }
  const buyer = linkProfile(sapBuyer(createdByName), null, dir);
  if (mark && buyer.name !== null && !isMarkedBuyer(buyer, mark)) {
    return NO_BUYER;
  }
  return buyer;
}

/** O3: lo que necesita `maximoKpiBuyer` de una OC de Maximo. */
export interface MaximoKpiFields {
  purchase_agent?: string | null;
  purchase_agent_name?: string | null;
  /** Ya no cuenta como comprador (O3); queda para "Capturó" en las tablas. */
  created_by?: string | null;
  /** O3: comprador de la RQ (`maximoRqBuyerJoin`). */
  rq_buyer?: string | null;
  rq_buyer_name?: string | null;
  /** O3: la OC trae CONTRACTREFNUM (`maximoPoDeContrato`). */
  de_contrato?: boolean | null;
}

/**
 * O3 (2026-10-26) — comprador de una OC de Maximo (o de la OC de SAP que
 * nació allá) para los KPIs por persona:
 *  1. de contrato → grupo "OC de contrato";
 *  2. el comprador de su RQ (CHANGEBY de RFQSTATUS): alias de Compras >
 *     DISPLAYNAME de esa fila > usuario;
 *  3. el agente de compras (PURCHASEAGENT), con la regla de E4;
 *  4. si no, sin comprador ("Capturó" ya no cuenta).
 * Un usuario de sistema (MAXADMIN, MAXREG) no es comprador: una RQ suya
 * cuenta como sin RQ (sigue el agente) y como agente, sin comprador.
 * `alias` = el nombre salió de Compras → Roles.
 */
export function maximoKpiBuyer(
  po: MaximoKpiFields,
  aliases: Map<string, string>,
  dir: PersonDirectory = EMPTY_DIRECTORY,
): KpiBuyer {
  if (po.de_contrato) return OC_DE_CONTRATO;
  // una RQ movida por un usuario de sistema no tiene comprador: sigue el agente
  const rqCode = po.rq_buyer?.trim() || null;
  const rq = rqCode && !isMaximoSystemUser(rqCode) ? rqCode : null;
  const code = rq ?? (po.purchase_agent?.trim() || null);
  if (code === null || isMaximoSystemUser(code)) {
    return { ...NO_BUYER, alias: false };
  }
  const buyer: KpiBuyer = rq
    ? {
        name: aliases.get(rq) ?? (po.rq_buyer_name?.trim() || null) ?? rq,
        kind: 'comprador',
      }
    : maximoBuyer(
        {
          purchase_agent: code,
          purchase_agent_name: po.purchase_agent_name ?? null,
          created_by: null,
        },
        aliases,
      );
  return linkProfile({ ...buyer, alias: aliases.has(code) }, code, dir);
}

/** Comprador inferido (quien creó o capturó la OC) con nombre. */
const isInferred = (buyer: Buyer) =>
  buyer.kind === 'capturo' && buyerKey(buyer.name) !== null;

export interface BuyerGroup<T> {
  /** null = sin persona: "Sin comprador identificado" u "OC de contrato" (`grupo`). */
  comprador: string | null;
  /** O3: persona, sin comprador o de contrato. */
  grupo: GrupoComprador;
  /** 'capturo' si al menos una de sus OC tiene comprador inferido; null sin persona. */
  tipo: BuyerKind;
  /** OC del grupo (suma de `weightOf`). */
  documentos: number;
  /** De esas, con comprador inferido. */
  documentos_capturo: number;
  items: T[];
}

/**
 * N2: llave de la persona = su perfil, si se pudo ligar; si no, el nombre
 * plegado. null = "Sin comprador identificado". O3: las OC de contrato van a
 * su propia llave.
 */
export function personKey(buyer: KpiBuyer): string | null {
  if (buyer.grupo === 'contrato') return CONTRATO_KEY;
  return buyer.profileId ? `perfil:${buyer.profileId}` : buyerKey(buyer.name);
}

/** O3: grupo de una llave de `personKey`. */
const grupoDe = (key: string | null): GrupoComprador =>
  key === null
    ? 'sin_comprador'
    : key === CONTRATO_KEY
      ? 'contrato'
      : 'persona';

/**
 * Agrupa por persona (`personKey`). Nombre del grupo = el del perfil si está
 * ligado; si no, el del alias de Compras si alguna OC lo trae; si no (o entre
 * varios), la variante con más OC (empate: la primera en orden alfabético).
 * `weightOf` = OC que representa cada elemento (renglón agrupado en M1; 1 por
 * OC en M2). Los grupos salen en el orden en que aparecen; el orden final lo
 * pone cada KPI.
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
      profileName: string | null;
      documentos: number;
      capturo: number;
      items: T[];
    }
  >();
  for (const item of items) {
    const buyer = buyerOf(item);
    const key = personKey(buyer);
    const weight = weightOf(item);
    const group = groups.get(key) ?? {
      variants: new Map<string, { oc: number; alias: boolean }>(),
      profileName: null,
      documentos: 0,
      capturo: 0,
      items: [],
    };
    group.items.push(item);
    group.documentos += weight;
    if (buyer.profileName) group.profileName = cleanName(buyer.profileName);
    if (grupoDe(key) === 'persona' && buyer.name) {
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
  return [...groups.entries()].map(([key, g]) => {
    const grupo = grupoDe(key);
    return {
      comprador:
        grupo !== 'persona'
          ? null
          : (g.profileName ??
            [...g.variants.entries()].sort(
              ([a, va], [b, vb]) =>
                Number(vb.alias) - Number(va.alias) ||
                vb.oc - va.oc ||
                a.localeCompare(b, 'es'),
            )[0]?.[0] ??
            null),
      grupo,
      tipo:
        grupo !== 'persona' ? null : g.capturo > 0 ? 'capturo' : 'comprador',
      documentos: g.documentos,
      documentos_capturo: g.capturo,
      items: g.items,
    };
  });
}

/** O3: personas primero; luego "Sin comprador identificado" y "OC de contrato". */
const porGrupo = (a: { grupo: GrupoComprador }, b: { grupo: GrupoComprador }) =>
  ORDEN_GRUPO[a.grupo] - ORDEN_GRUPO[b.grupo];

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
  /** null = sin persona ("Sin comprador identificado" u "OC de contrato"). */
  comprador: string | null;
  /** O3: persona, sin comprador o de contrato. */
  grupo: GrupoComprador;
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
 * más OC; "Sin comprador identificado" y "OC de contrato" al final (O3).
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
      grupo: g.grupo,
      tipo: g.tipo,
      documentos: g.documentos,
      documentos_capturo: g.documentos_capturo,
      por_moneda: sumByCurrency(g.items),
    }))
    .sort(
      (a, b) =>
        porGrupo(a, b) ||
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

// ── N1: monto adjudicado y ahorro por comprador ────────────────────────────

/**
 * N1: un renglón de las consultas de OC sin IVA (agrupadas por comprador y
 * moneda), con los mismos filtros de la tarjeta de Órdenes del tablero.
 */
export interface AdjudicadoEntry {
  fuente: 'sap' | 'maximo';
  currency: string | null;
  buyer: KpiBuyer;
  /** Σ subtotal (sin IVA) de las OC que lo traen. */
  total: number;
  /** OC del renglón. */
  count: number;
  /** De esas, sin subtotal: no suman; se cuentan aparte, nunca como 0. */
  sin_subtotal: number;
}

/** N1: monto adjudicado de una moneda (sin IVA) con las OC sin subtotal aparte. */
export interface AdjudicadoAmount {
  currency: string | null;
  total: number;
  count: number;
  sin_subtotal: number;
}

/** Suma por moneda del adjudicado, sin convertir; de mayor a menor. */
export function sumAdjudicado(
  entries: Array<{
    currency: string | null;
    total: number;
    count: number;
    sin_subtotal: number;
  }>,
): AdjudicadoAmount[] {
  const map = new Map<string, AdjudicadoAmount>();
  for (const e of entries) {
    if (e.count <= 0) continue;
    const key = e.currency ?? 'sin_moneda';
    const acc = map.get(key) ?? {
      currency: e.currency,
      total: 0,
      count: 0,
      sin_subtotal: 0,
    };
    acc.total += e.total;
    acc.count += e.count;
    acc.sin_subtotal += e.sin_subtotal;
    map.set(key, acc);
  }
  return [...map.values()]
    .map((a) => ({ ...a, total: round2(a.total) }))
    .sort((a, b) => b.total - a.total);
}

export interface CompradorAdjudicado {
  /** null = sin persona ("Sin comprador identificado" u "OC de contrato"). */
  comprador: string | null;
  /** O3: persona, sin comprador o de contrato. */
  grupo: GrupoComprador;
  tipo: BuyerKind;
  /** OC adjudicadas del periodo. */
  documentos: number;
  /** De esas, con comprador inferido (capturó o creó la OC). */
  documentos_capturo: number;
  /** Monto adjudicado sin IVA, por moneda. */
  adjudicado: AdjudicadoAmount[];
  /** Ahorro capturado (el de la tarjeta), por moneda. */
  ahorro: { documentos: number; por_moneda: CurrencyAmount[] };
}

const mxnAdjudicado = (list: AdjudicadoAmount[]) =>
  list.find((a) => a.currency === 'MXN')?.total ?? 0;

/**
 * N1: por persona, el monto adjudicado y el ahorro, de los mismos renglones
 * que la tarjeta de Órdenes del tablero (adjudicado) y que "Ahorro acumulado"
 * (ahorro). Orden: adjudicado en MXN de mayor a menor; "Sin comprador
 * identificado" y "OC de contrato" al final (O3).
 */
export function compradoresAdjudicado(
  adjudicado: AdjudicadoEntry[],
  ahorro: AhorroEntry[],
): CompradorAdjudicado[] {
  type Item =
    | { kind: 'adj'; e: AdjudicadoEntry }
    | { kind: 'ahorro'; e: AhorroEntry };
  const items: Item[] = [
    ...adjudicado.map((e): Item => ({ kind: 'adj', e })),
    ...ahorro.map((e): Item => ({ kind: 'ahorro', e })),
  ];
  return groupByBuyer(
    items,
    (i) => i.e.buyer,
    // OC = las adjudicadas; el ahorro es de esas mismas OC
    (i) => (i.kind === 'adj' ? i.e.count : 0),
  )
    .map((g) => {
      const adj = g.items.flatMap((i) => (i.kind === 'adj' ? [i.e] : []));
      const ah = g.items.flatMap((i) => (i.kind === 'ahorro' ? [i.e] : []));
      return {
        comprador: g.comprador,
        grupo: g.grupo,
        tipo: g.tipo,
        documentos: g.documentos,
        documentos_capturo: g.documentos_capturo,
        adjudicado: sumAdjudicado(adj),
        ahorro: {
          documentos: ah.reduce((sum, e) => sum + e.count, 0),
          por_moneda: sumByCurrency(ah),
        },
      };
    })
    .sort(
      (a, b) =>
        porGrupo(a, b) ||
        mxnAdjudicado(b.adjudicado) - mxnAdjudicado(a.adjudicado) ||
        b.documentos - a.documentos ||
        byName(a.comprador, b.comprador),
    );
}

/**
 * N1: total del monto adjudicado (sin IVA) por moneda y por fuente: la suma
 * de las barras por persona = este total = las OC sin IVA de la tarjeta de
 * Órdenes del tablero (mismas OC, mismo periodo, D1).
 */
export function buildAdjudicado(entries: AdjudicadoEntry[]) {
  const sap = entries.filter((e) => e.fuente === 'sap');
  const maximo = entries.filter((e) => e.fuente === 'maximo');
  const docs = (list: AdjudicadoEntry[]) =>
    list.reduce((sum, e) => sum + e.count, 0);
  return {
    disponible: docs(entries) > 0,
    documentos: docs(entries),
    por_moneda: sumAdjudicado(entries),
    por_fuente: {
      sap: { documentos: docs(sap), por_moneda: sumAdjudicado(sap) },
      maximo: { documentos: docs(maximo), por_moneda: sumAdjudicado(maximo) },
    },
  };
}

// ── M2: tiempo de gestión por comprador ────────────────────────────────────

/** M2: días de un comprador con la misma cuenta de G2 (promedio, mediana y N). */
export interface GestionPorComprador extends SapGestionResult {
  /** null = sin persona ("Sin comprador identificado" u "OC de contrato"). */
  comprador: string | null;
  /** O3: persona, sin comprador o de contrato. */
  grupo: GrupoComprador;
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

const tipoGestion = (grupo: GrupoComprador, capturo: number): BuyerKind =>
  grupo !== 'persona' ? null : capturo > 0 ? 'capturo' : 'comprador';

/**
 * N2 (2026-10-16): orden de la tabla. Los de N ≥ `minOc` por gestiones, de
 * más a menos (empate: el más rápido primero); luego los de menos OC;
 * "Sin comprador identificado" y "OC de contrato" al final (O3). (M2 los
 * ordenaba por días.)
 */
export function sortGestion<
  T extends {
    comprador: string | null;
    grupo: GrupoComprador;
    total: number;
    promedio_dias: number | null;
  },
>(list: T[], minOc = MIN_OC_GESTION): T[] {
  const rank = (g: T) =>
    g.grupo !== 'persona' ? 1 + ORDEN_GRUPO[g.grupo] : g.total >= minOc ? 0 : 1;
  const promedio = (g: T) => g.promedio_dias ?? Number.MAX_VALUE;
  return [...list].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.total - a.total ||
      promedio(a) - promedio(b) ||
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
      grupo: g.grupo,
      tipo: tipoGestion(g.grupo, capturo),
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
      grupo: g.grupo,
      tipo: tipoGestion(g.grupo, capturo),
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

/** N2: gestiones de una persona en los dos sistemas. */
export interface GestionAmbos {
  comprador: string | null;
  /** O3: persona, sin comprador o de contrato. */
  grupo: GrupoComprador;
  tipo: BuyerKind;
  /** De las N, con comprador inferido. */
  documentos_capturo: number;
  /** Promedio y mediana de los días de cada OC de los dos sistemas. */
  promedio_dias: number | null;
  mediana_dias: number | null;
  /** N = OC de SAP + OC de Maximo que entran en G2. */
  total: number;
  sap: number;
  maximo: number;
}

export const GESTION_AMBOS_DEFINICION =
  'Ambos sistemas: cada OC cuenta una vez en su sistema y mide desde su propia solicitud (SAP, la solicitud de pedido; Maximo, la PR); la N es la suma de las dos y el promedio y la mediana salen de los días de cada OC';

/**
 * N2: "Ambos" = SAP + Maximo juntos por persona. Los días de cada OC salen de
 * las mismas funciones del tablero (`sapGestionValues`, `maximoGestionValues`,
 * definición principal de Maximo: desde la creación de la PR); promedio y
 * mediana se calculan sobre la unión, nunca promediando medianas.
 */
export function buildGestionAmbos(
  sap: { pos: SapGestionOc[]; requests: SapGestionRequest[] },
  maximo: MaximoGestionOc[],
  minOc = MIN_OC_GESTION,
) {
  type Item = { sap: SapGestionOc } | { mx: MaximoGestionOc };
  const items: Item[] = [
    ...sap.pos.map((po): Item => ({ sap: po })),
    ...maximo.map((r): Item => ({ mx: r })),
  ];
  const daysOf = (list: Item[], onlyInferred = false) => {
    const sapItems = list.flatMap((i) =>
      'sap' in i && (!onlyInferred || isInferred(i.sap.buyer)) ? [i.sap] : [],
    );
    const mxItems = list.flatMap((i) =>
      'mx' in i && (!onlyInferred || isInferred(i.mx.buyer)) ? [i.mx] : [],
    );
    return {
      sap: sapGestionValues(sapItems, sap.requests).days,
      maximo: maximoGestionValues(mxItems).days,
    };
  };
  const compradores = groupByBuyer(items, (i) =>
    'sap' in i ? i.sap.buyer : i.mx.buyer,
  ).map((g): GestionAmbos => {
    const days = daysOf(g.items);
    const inferred = daysOf(g.items, true);
    const capturo = inferred.sap.length + inferred.maximo.length;
    return {
      comprador: g.comprador,
      grupo: g.grupo,
      tipo: tipoGestion(g.grupo, capturo),
      documentos_capturo: capturo,
      ...averageAndMedian([...days.sap, ...days.maximo]),
      total: days.sap.length + days.maximo.length,
      sap: days.sap.length,
      maximo: days.maximo.length,
    };
  });
  const all = daysOf(items);
  return {
    definicion: GESTION_AMBOS_DEFINICION,
    total: {
      ...averageAndMedian([...all.sap, ...all.maximo]),
      total: all.sap.length + all.maximo.length,
      sap: all.sap.length,
      maximo: all.maximo.length,
    },
    compradores: sortGestion(
      compradores.filter((g) => g.total > 0),
      minOc,
    ),
  };
}

/**
 * M2: bloque `gestion_por_comprador` de Órdenes. `total` = el mismo
 * resultado de G2 que el tablero (`summary.dias_gestion`) para las mismas OC;
 * las definiciones son las del tablero. N2: más `ambos`.
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
    ambos: buildGestionAmbos(sap, maximo, minOc),
  };
}
