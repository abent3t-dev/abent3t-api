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
 *
 * Bloque K (2026-10-05): las vistas de Maximo viven SOLO aquí (se borraron
 * las copias de maximo-records, purchase-reports y expeditación). Las de
 * contratos excluyen las revisiones obsoletas (`superseded_at`, K8) y hay
 * una vista por PR (`CURRENT_MAXIMO_PRS`, K3). K4: las definiciones por PR
 * (pendiente, de contrato, en aprobación, llegada a Compras) y la consulta
 * de G2 de Maximo también viven aquí; el folio ya no ubica a las PR.
 */

export const CURRENT_MAXIMO_POS = Prisma.sql`
  SELECT DISTINCT ON (ponum, coalesce(siteid, '')) *
  FROM maximo_purchase_orders
  ORDER BY ponum, coalesce(siteid, ''), coalesce(revisionnum, 0) DESC`;

/**
 * Vista actual de contratos: mayor revisionnum por (prnum, contractnum),
 * sin las filas obsoletas (K8: la revisión ya no viene en el registro de su
 * PR, p. ej. la fila sin contrato de una PR que después tuvo contrato).
 */
export const CURRENT_MAXIMO_CONTRACTS = Prisma.sql`
  SELECT DISTINCT ON (coalesce(prnum, ''), coalesce(contractnum, '')) *
  FROM maximo_contracts
  WHERE superseded_at IS NULL
  ORDER BY coalesce(prnum, ''), coalesce(contractnum, ''),
    coalesce(revisionnum, 0) DESC`;

/**
 * K3 (2026-10-05): vista POR PR de Maximo, una fila por `prnum` y sin las
 * obsoletas. Con contrato gana la revisión más alta; los `pr_*` (estatus,
 * fechas y quién, de la raíz de AB_CONTRATOS) son iguales en todas las
 * revisiones. `de_contrato` = alguna fila vigente de la PR tiene contrato y
 * solo existe en esta vista. `last_seen_at` va al final del orden: cada
 * revisión recibe su propio `new Date()` en la sync y, si fuera antes,
 * ganaría la última procesada según el orden de PURCHVIEW.
 * Todo conteo por PR usa esta vista.
 */
export const CURRENT_MAXIMO_PRS = Prisma.sql`
  SELECT DISTINCT ON (prnum) *, bool_or(has_contract) OVER (PARTITION BY prnum) AS de_contrato
  FROM maximo_contracts
  WHERE prnum IS NOT NULL AND superseded_at IS NULL
  ORDER BY prnum, has_contract DESC, coalesce(revisionnum, 0) DESC, last_seen_at DESC`;

/*
 * K6 (2026-10-05) — Dos bases de montos de OC:
 *  - con IVA: `doc_total` (DocTotal) en SAP y `total_cost` (TOTALCOST) en
 *    Maximo;
 *  - sin IVA: `subtotal` (0019) = suma de las líneas en la moneda del
 *    documento (LineTotal/RowTotalFC en SAP, POLINE.LINECOST en Maximo).
 *    null si la OC no tiene líneas o a alguna le falta importe: esas OC no
 *    suman a la base sin IVA y se cuentan aparte (`sin_subtotal`); nunca se
 *    estiman con TOTALCOST/1.16 ni con PRETAXTOTAL.
 * El tablero, Reportes y el Top 10 usan `TABLERO_MONTO_BASE`; el avance
 * semanal tiene su propia constante (AVANCE_MONTO_BASE, K5). Las
 * solicitudes de SAP ya son sin IVA (suma de sus líneas) y no cambian.
 */

/** K6: base de un monto de OC. */
export type MontoBase = 'con_iva' | 'sin_iva';

/**
 * K6: base del tablero, Reportes y el Top 10, hasta que conteste Ingrid
 * ("¿montos sin IVA también en el tablero?"). Si cambia, se cambia aquí y
 * nada más; el subtotal sin IVA ya viaja como dato secundario.
 */
export const TABLERO_MONTO_BASE: MontoBase = 'con_iva';

/** K6: columna del monto de una OC de SAP (`alias`) en la base pedida. */
export function sapPoMonto(alias: string, base: MontoBase): Prisma.Sql {
  return Prisma.raw(
    `${alias}.${base === 'sin_iva' ? 'subtotal' : 'doc_total'}`,
  );
}

/** K6: columna del monto de una OC de Maximo (`alias`) en la base pedida. */
export function maximoPoMonto(alias: string, base: MontoBase): Prisma.Sql {
  return Prisma.raw(
    `${alias}.${base === 'sin_iva' ? 'subtotal' : 'total_cost'}`,
  );
}

/**
 * K6: columnas `subtotal` (suma sin IVA de las OC que lo tienen) y
 * `sin_subtotal` (cuántas no) para un SELECT agrupado sobre OC de SAP o de
 * Maximo (las dos tablas llaman igual a la columna).
 */
export function poSubtotalColumns(alias: string): Prisma.Sql {
  const col = Prisma.raw(`${alias}.subtotal`);
  return Prisma.sql`coalesce(sum(${col}), 0) AS subtotal,
    count(*) FILTER (WHERE ${col} IS NULL)::int AS sin_subtotal`;
}

/**
 * H10 (2026-10-05): monto de las OC propias de ABENT en la base del tablero.
 * El modelo propio no dice si `amount` lleva IVA (base desconocida): nunca
 * suman al subtotal y van todas a `sin_subtotal`; con base con IVA su
 * `amount` entra al total como hasta ahora y con base sin IVA no se suma
 * (igual que una OC de SAP o Maximo sin subtotal). Lo usan el tablero y el
 * Resumen de Reportes, para que no se desalineen.
 */
export function abentMontoEnBase(
  amount: number,
  count: number,
  base: MontoBase = TABLERO_MONTO_BASE,
): { total: number; subtotal: number; sin_subtotal: number } {
  return {
    total: base === 'sin_iva' ? 0 : amount,
    subtotal: 0,
    sin_subtotal: count,
  };
}

/** K6: texto de la base para notas y tooltips (reemplaza los "con IVA" fijos). */
export function montoBaseNota(base: MontoBase): string {
  return base === 'sin_iva'
    ? 'sin IVA (suma de las líneas; las OC sin subtotal no suman)'
    : 'con IVA (DocTotal de SAP, TOTALCOST de Maximo)';
}

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
 * `AND` de una expresión de fecha dentro de [from, toExcl); cada límite null
 * queda abierto (los dos null → nada).
 */
export function andBetween(
  expr: Prisma.Sql,
  from: Date | null,
  toExcl: Date | null,
): Prisma.Sql {
  const desde = from ? Prisma.sql`AND ${expr} >= ${from}` : Prisma.empty;
  const hasta = toExcl ? Prisma.sql`AND ${expr} < ${toExcl}` : Prisma.empty;
  return Prisma.sql`${desde} ${hasta}`;
}

/*
 * O (2026-10-26) — Datos de AB_COMPRAS que CIISA agregó y que no tienen
 * columna (sin migración): se leen del `raw` de la OC, en sus tres formas
 * (legacy anidado `Attributes`/`RelatedMbos`, compacto y OSLC en
 * minúsculas), con la MISMA regla que el mapper (`contractRefNumOf`,
 * `rfqBuyerOf` y `exchangeRate` en maximo.mapper.ts). Solo se mira la
 * cabecera y las líneas (POLINE): recorrer todo el JSON con `.**` costaba
 * ~14 veces más (2.5 s contra 0.18 s por cada 5,000 OC).
 */

/**
 * Texto de un escalar del raw como lo desenvuelve el canonizador: texto o
 * número tal cual, `{ content: X }` → X; booleanos y lo demás → NULL.
 */
function rawScalar(value: string): string {
  return `(CASE jsonb_typeof(${value})
    WHEN 'string' THEN ${value} #>> '{}' WHEN 'number' THEN ${value} #>> '{}'
    WHEN 'object' THEN (CASE WHEN jsonb_typeof(${value} -> 'content') IN ('string', 'number')
      THEN ${value} ->> 'content' END) END)`;
}

/**
 * Texto de un atributo de un nodo del raw, sin espacios ASCII a los lados
 * (espacio, tabulador, saltos, \f y \v: los mismos que recorta el mapper);
 * vacío y "~null~" → NULL.
 */
function rawText(node: string, key: string): string {
  const upper = key.toUpperCase();
  const lower = key.toLowerCase();
  return `nullif(nullif(btrim(coalesce(${rawScalar(`(${node} #> '{Attributes,${upper}}')`)},
    ${rawScalar(`(${node} -> '${upper}')`)}, ${rawScalar(`(${node} -> '${lower}')`)}),
    E' \\t\\n\\r\\f\\x0B'), ''), '~null~')`;
}

/** Número de un atributo de un nodo del raw; si no es número, NULL. */
function rawNumber(node: string, key: string): string {
  const text = rawText(node, key);
  return `(CASE WHEN ${text} ~ '^[-+]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][-+]?[0-9]+)?$' THEN (${text})::numeric END)`;
}

/** Hijos `key` de un nodo del raw como arreglo (si no es arreglo, vacío). */
function rawChildren(node: string, key: string): string {
  const upper = key.toUpperCase();
  const value = `coalesce(${node} #> '{RelatedMbos,${upper}}', ${node} -> '${upper}', ${node} -> '${key.toLowerCase()}')`;
  return `(CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END)`;
}

/**
 * La cabecera de la OC (`alias.raw`) y sus líneas: una fila por nodo,
 * columnas `n` y `nodo_ord` (0 la cabecera; las líneas en su orden).
 */
function rawHeaderAndLines(alias: string): string {
  return `SELECT ${alias}.raw AS n, 0::bigint AS nodo_ord
    UNION ALL SELECT l.value, l.ord
    FROM jsonb_array_elements(${rawChildren(`${alias}.raw`, 'POLINE')}) WITH ORDINALITY AS l(value, ord)`;
}

/**
 * O1/O3: la OC de Maximo (`alias`, con `raw`) es de contrato = trae
 * CONTRACTREFNUM con valor en la cabecera o en una línea (mapper:
 * `contractRefNumOf`). Es la marca de "OC de contrato" de los montos del
 * avance (O1) y de las gráficas por comprador (O3).
 */
export function maximoPoDeContrato(alias: string): Prisma.Sql {
  return Prisma.raw(`EXISTS (SELECT 1 FROM (${rawHeaderAndLines(alias)}) AS nodos
    WHERE ${rawText('nodos.n', 'CONTRACTREFNUM')} IS NOT NULL)`);
}

/**
 * O1: PO.EXCHANGERATE de la OC (`alias`), CONTRA EL DÓLAR (la moneda base
 * de Maximo): ~0.058 en pesos, 1 en dólares y ~1.19 en euros. NULL si no
 * viene o no es número.
 */
export function maximoPoExchangeRate(alias: string): Prisma.Sql {
  return Prisma.raw(rawNumber(`${alias}.raw`, 'EXCHANGERATE'));
}

/**
 * O3: comprador de la RQ de la OC (`alias`) como `LEFT JOIN LATERAL` con
 * alias `as`: columnas `rq_buyer` (CHANGEBY), `rq_buyer_name`
 * (PERSON.DISPLAYNAME de esa fila, salvo que su PERSONID sea otro) y
 * `rq_num` (RFQNUM). Es la fila de RFQSTATUS de la cabecera o de una línea
 * con CHANGEBY y el RFQSTATUSSEQ más alto (sin número al final; empate, el
 * usuario menor y luego la primera que llega), con el nombre de su primera
 * PERSON. Mapper: `rfqBuyerOf`. Sin RQ, las tres en NULL.
 */
export function maximoRqBuyerJoin(alias: string, as = 'rq'): Prisma.Sql {
  return Prisma.raw(`LEFT JOIN LATERAL (
    SELECT f.changeby AS rq_buyer,
           CASE WHEN f.personid IS NULL OR upper(f.personid) = upper(f.changeby)
                THEN f.displayname END AS rq_buyer_name,
           f.rfqnum AS rq_num
    FROM (
      SELECT ${rawText('r.value', 'CHANGEBY')} AS changeby,
             ${rawNumber('r.value', 'RFQSTATUSSEQ')} AS seq,
             ${rawText('r.value', 'RFQNUM')} AS rfqnum,
             ${rawText('p.person', 'DISPLAYNAME')} AS displayname,
             ${rawText('p.person', 'PERSONID')} AS personid,
             nodos.nodo_ord, r.ord AS fila_ord
      FROM (${rawHeaderAndLines(alias)}) AS nodos
      CROSS JOIN LATERAL jsonb_array_elements(${rawChildren('nodos.n', 'RFQSTATUS')})
        WITH ORDINALITY AS r(value, ord)
      LEFT JOIN LATERAL (
        SELECT pe.value AS person
        FROM jsonb_array_elements(${rawChildren('r.value', 'PERSON')}) WITH ORDINALITY AS pe(value, ord)
        WHERE jsonb_typeof(pe.value) = 'object'
        ORDER BY pe.ord
        LIMIT 1
      ) AS p ON true
    ) f
    WHERE f.changeby IS NOT NULL
    ORDER BY f.seq DESC NULLS LAST, f.changeby COLLATE "C", f.nodo_ord, f.fila_ord
    LIMIT 1
  ) ${as} ON true`);
}

/** PRNUM que ya tienen OC: las de las OC vigentes no canceladas (G3). */
export const MAXIMO_PRS_WITH_PO = Prisma.sql`
  SELECT DISTINCT unnest(p.pr_nums) AS prnum
  FROM (${CURRENT_MAXIMO_POS}) p
  WHERE coalesce(p.status, '') NOT IN ('CAN', 'CANCEL')`;

/*
 * K4 (2026-10-05) — Definiciones por PR de Maximo, sobre el alias de
 * `CURRENT_MAXIMO_PRS` (una fila por PR, sin obsoletas; `de_contrato` solo
 * existe ahí). Miran el estatus DE LA PR (`pr_status`, raíz de
 * AB_CONTRATOS, K3), no el del contrato: un contrato en APPR con la PR en
 * CLOSE no es pendiente. Antes (G3) pendiente = fila sin contrato y sin OC,
 * sin mirar el estatus: entraban las CAN y CLOSE sin OC (≈1,250 contra ≤45
 * APPR) y se contaban filas, no PR.
 *
 *  - pendiente de gestionar = aprobada (APPR: ya llegó a Compras), sin
 *    contrato y sin OC vigente que la use;
 *  - I8 "de contrato" = lo mismo con contrato (la OC se genera en
 *    automático, Ingrid); va aparte;
 *  - aprobada con OC = APPR con OC vigente, con o sin contrato (solo dato).
 *    Las tres juntas son todas las APPR;
 *  - en aprobación = WAPPR: todavía no llega a Compras; va aparte, sin
 *    sumarse (no confundir con `maximoInApproval`, que es de OC).
 */

/** K4: PR aprobada (APPR) sin contrato ni OC vigente = pendiente de gestionar. */
export function maximoPrPending(alias: string): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}.pr_status = 'APPR' AND NOT ${a}.de_contrato
    AND ${a}.prnum NOT IN (${MAXIMO_PRS_WITH_PO}))`;
}

/** K4/I8: PR de contrato aprobada (APPR) sin OC vigente. */
export function maximoContractPrPending(alias: string): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}.pr_status = 'APPR' AND ${a}.de_contrato
    AND ${a}.prnum NOT IN (${MAXIMO_PRS_WITH_PO}))`;
}

/** K4: PR aprobada (APPR) que ya tiene OC vigente, con o sin contrato. */
export function maximoPrApprovedWithPo(alias: string): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}.pr_status = 'APPR'
    AND ${a}.prnum IN (${MAXIMO_PRS_WITH_PO}))`;
}

/** K4: PR en aprobación (WAPPR); se ubica por su emisión (`pr_issue_date`). */
export function maximoPrInApproval(alias: string): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}.pr_status = 'WAPPR')`;
}

/**
 * K4: llegada a Compras de la PR = su primer APPR (`pr_approved_at`); sin
 * APPR en el historial, su emisión. FIJA para tablero, Reportes y listados:
 * no lee `AVANCE_REGLAS` (si el default del avance cambia tras la
 * conciliación, los pendientes no se mueven) y erp-views no importa nada de
 * purchase-reports.
 */
export function maximoPrLlegada(alias: string): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`coalesce(${a}.pr_approved_at, ${a}.pr_issue_date)`;
}

/** Fila de `maximoGestionSql`: días por OC; null = sin la fecha de su PR. */
export interface MaximoGestionRow {
  dias: unknown;
  dias_desde_aprobacion: unknown;
  /**
   * M2 (2026-10-14, Ingrid): datos del comprador de la OC (regla E4/F1,
   * `maximoBuyer`) para agrupar los mismos días por comprador. Opcionales:
   * `maximoGestion` no los lee.
   */
  ponum?: string | null;
  purchase_agent?: string | null;
  purchase_agent_name?: string | null;
  created_by?: string | null;
  /**
   * O3 (2026-10-26), solo con `{ comprador: true }`: comprador de la RQ
   * (`maximoRqBuyerJoin`) y si la OC es de contrato (`maximoPoDeContrato`).
   */
  rq_buyer?: string | null;
  rq_buyer_name?: string | null;
  de_contrato?: boolean | null;
}

/**
 * G2 de Maximo (K4.3, 2026-10-05), una fila por OC vigente no cancelada con
 * fecha (`created_at_source`) en [from, toExcl) (sin límites = todas):
 *  - `dias` = fecha de la OC − creación de su solicitud (definición de
 *    Ingrid del 28-sep): `pr_issue_date` de la OC (ISSUEDATE de la PR de su
 *    línea, 0016) y, si la línea no la trae, la más antigua de sus PR
 *    (`pr_nums`) en `CURRENT_MAXIMO_PRS` (ISSUEDATE de AB_CONTRATOS, K3).
 *    Misma definición; solo sube la N;
 *  - `dias_desde_aprobacion` = fecha de la OC − el primer APPR más antiguo
 *    de sus PR (llegada a Compras), dato secundario.
 * Un solo lugar para el tablero y Reportes.
 *
 * M2 (2026-10-14): trae también el PONUM, PURCHASEAGENT y creador de cada OC
 * para agrupar los mismos días por comprador en Órdenes (columnas extra; el
 * cálculo no cambia).
 *
 * O3 (2026-10-26): con `{ comprador: true }` (solo Órdenes) agrega el
 * comprador de la RQ y la marca de contrato, que se leen del `raw`; el
 * tablero y Reportes no los piden y no pagan esa lectura.
 */
export function maximoGestionSql(
  from: Date | null,
  toExcl: Date | null,
  opciones: { comprador?: boolean } = {},
): Prisma.Sql {
  const comprador = opciones.comprador
    ? Prisma.sql`, ${maximoPoDeContrato('oc')} AS de_contrato,
           rq.rq_buyer, rq.rq_buyer_name`
    : Prisma.empty;
  const rq = opciones.comprador ? maximoRqBuyerJoin('oc') : Prisma.empty;
  return Prisma.sql`
    WITH oc AS (
      SELECT v.* FROM (${CURRENT_MAXIMO_POS}) v
      WHERE coalesce(v.status, '') NOT IN ('CAN', 'CANCEL')
        ${andBetween(Prisma.sql`v.created_at_source`, from, toExcl)}
    ),
    fechas AS (
      SELECT oc.id, min(p.pr_issue_date) AS emision,
             min(p.pr_approved_at) AS aprobacion
      FROM oc
      CROSS JOIN LATERAL unnest(oc.pr_nums) AS u(prnum)
      JOIN (${CURRENT_MAXIMO_PRS}) p ON p.prnum = u.prnum
      GROUP BY oc.id
    )
    SELECT extract(epoch FROM (oc.created_at_source
             - coalesce(oc.pr_issue_date, f.emision))) / 86400 AS dias,
           extract(epoch FROM (oc.created_at_source - f.aprobacion)) / 86400
             AS dias_desde_aprobacion,
           oc.ponum, oc.purchase_agent, oc.purchase_agent_name, oc.created_by
           ${comprador}
    FROM oc LEFT JOIN fechas f ON f.id = oc.id ${rq}`;
}

/**
 * Fila de `sapGestionSql`: una OC de SAP con solicitud base (G2/D3). M2:
 * `created_by_name` y `maximo_ponum` son para su comprador (E4/F1).
 */
export interface SapGestionRow {
  doc_entry: number;
  doc_date: Date | null;
  base_request_entries: number[];
  created_by_name: string | null;
  maximo_ponum: string | null;
}

/**
 * G2 de SAP (D3): OC no canceladas que nacieron de una solicitud de pedido,
 * con fecha (`doc_date`) en [from, toExcl) (sin límites = todas). Los días
 * se calculan en memoria con `sapGestionDays`. Por sistema: aquí NO se
 * descuentan las migradas (D1 es de los totales combinados).
 *
 * M2 (2026-10-14): una sola consulta para el tablero (`getSummary`) y la
 * gráfica por comprador de Órdenes (`getOrdersKpis`), para que el periodo y
 * el conjunto de OC sean los mismos en las dos.
 */
export function sapGestionSql(
  from: Date | null,
  toExcl: Date | null,
): Prisma.Sql {
  return Prisma.sql`
    SELECT doc_entry, doc_date, base_request_entries, created_by_name, maximo_ponum
    FROM sap_purchase_orders
    WHERE cancelled IS DISTINCT FROM true
      AND cardinality(base_request_entries) > 0
      ${andBetween(Prisma.sql`doc_date`, from, toExcl)}`;
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
