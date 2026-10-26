import { canonicalize } from '../../common/maximo/maximo-canonical';
import { compareStatusChange } from '../../common/maximo/maximo-status-order';
import {
  MAXIMO_CONTRACT_EXPENSE_TYPE,
  MaximoContractDto,
  MaximoContractLineDto,
  MaximoPrStatusChangeDto,
} from './dto/maximo-contract.dto';
import {
  MAXIMO_ERP,
  MaximoPersonDto,
  MaximoPurchaseOrderDto,
  MaximoPurchaseOrderLineDto,
  MaximoPurchaseRequestRefDto,
  MaximoRfqBuyerDto,
  MaximoStatusChangeDto,
  MaximoVendorDto,
} from './dto/maximo-po.dto';
import {
  MaximoCanonicalRecord,
  MaximoObjectStructure,
} from './dto/maximo-raw.types';
import { MaximoMappingError, MaximoResponseShapeError } from './maximo.errors';

/**
 * Versión del mapper. Se persiste por fila de staging (Int-3): permite saber
 * qué reglas produjeron las columnas mapeadas. Subirla en CADA cambio de
 * reglas de mapeo: si no sube, el sync ve la fila igual (mismo rowstamp,
 * hash y versión → 'unchanged') y el cambio no se aplica a lo ya guardado.
 * K8 (2026-10-05): tras desplegar NO hay paso manual: el primer full del
 * sync re-mapea las filas con otra versión como 'remapped' (sin tocar
 * `last_changed_at`; `records_remapped` en maximo_sync_runs). Si hace falta
 * forzarlo, un full manual (`POST /integrations/maximo/sync
 * {"target":"all"}`). `maximo:remap` queda para dev y emergencias y NUNCA
 * con una corrida del sync en curso (el historial choca con el UNIQUE) ni
 * antes del primer full (deja versión y hash nuevos y el full sale casi todo
 * 'unchanged': el smoke de `records_remapped` fallaría sin defecto).
 * Histórico (2026-09-21): Isaac confirmó CONTRACTVALUE=TOTALCOST y
 * CONTRACTREFNUM=CONTRACTNUM (§20.2 resuelta); antes de K8 eso se aplicaba
 * con `maximo:remap`.
 * O (2026-10-26): los campos nuevos de la OC (comprador de la RQ, tipo de
 * cambio y referencia de contrato) no tienen columna: se leen del `raw` (en
 * SQL, erp-views), que el sync ya guarda completo. La versión sube para que
 * el primer full los marque 'remapped' y no 'updated'.
 */
export const MAXIMO_MAPPER_VERSION = '2026.10.26-1'; // 10.26-1: rfqBuyer/rfqNums (RFQSTATUS, O3) + exchangeRate + contractRefNum (O1); 10.05-1: PO5 (K2) + PR raíz e historial (K3) + LINECOST/subtotal (K6) + líneas ordenadas; 10.01-1: receiptStatus (I1b); 28-1: prIssueDate = PR más antigua + prNums (G2/G3); 25-2: createdBy = CHANGEBY del primer estatus (F1); 25-1: comprador PURCHASEAGENT → PERSON (E4); 23-1: prStatus/prTotal/consumedValue (D2/D7/D8)

/**
 * Capa ÚNICA de mapeo crudo → DTO interno (Fase INT-2).
 *
 * Funciones puras: sin I/O, sin estado, sin Logger. Aceptan cualquiera de las
 * tres formas de Maximo (legacy anidado, legacy compacto, OSLC lean) porque
 * primero normalizan a `MaximoCanonicalRecord` (`toCanonical`). Los campos
 * que Maximo omite salen como `null` explícito en el DTO.
 */

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normaliza un registro de cualquiera de las tres formas con el canonizador
 * común (`common/maximo/maximo-canonical.ts`, K3.7): claves UPPERCASE,
 * escalares desenvueltos, hijos como arrays canónicos, `rowstamp`/`_rowstamp`
 * → `ROWSTAMP`, metadatos OSLC descartados. A diferencia del común, aquí un
 * registro que no es objeto LANZA: el mapper lo rechaza y el sync lo cuenta
 * como fallido.
 */
export function toCanonical(raw: unknown): MaximoCanonicalRecord {
  const r = canonicalize(raw);
  if (!r) throw new MaximoMappingError('el registro no es un objeto', '$');
  return r;
}

// ---------------------------------------------------------------------------
// Accesores tipados sobre el registro canónico
// ---------------------------------------------------------------------------

function str(rec: MaximoCanonicalRecord | null, key: string): string | null {
  const v = rec?.[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
}

function num(rec: MaximoCanonicalRecord | null, key: string): number | null {
  const v = rec?.[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function children(
  rec: MaximoCanonicalRecord | null,
  key: string,
): MaximoCanonicalRecord[] {
  const v = rec?.[key];
  return Array.isArray(v) ? v : [];
}

function first(
  rec: MaximoCanonicalRecord | null,
  key: string,
): MaximoCanonicalRecord | null {
  return children(rec, key)[0] ?? null;
}

function hasKey(rec: MaximoCanonicalRecord | null, key: string): boolean {
  return rec !== null && Object.prototype.hasOwnProperty.call(rec, key);
}

/**
 * O (2026-10-26): la cabecera de la OC y sus líneas (POLINE), en ese orden.
 * Ahí se buscan CONTRACTREFNUM (viene en la cabecera y puede venir en las
 * líneas) y RFQSTATUS (CIISA no dijo en qué nivel lo puso). Solo esos dos
 * niveles, igual que en SQL (erp-views): recorrer todo el JSON en cada
 * consulta costaba ~14 veces más.
 */
function headerAndLines(r: MaximoCanonicalRecord): MaximoCanonicalRecord[] {
  return [r, ...children(r, 'POLINE')];
}

/** Espacios que recorta el SQL (`btrim` con estos caracteres en erp-views). */
const ESPACIOS_ASCII = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

/**
 * O: texto de un campo como lo lee el SQL (`rawText` en erp-views): sin
 * espacios ASCII a los lados; vacío y "~null~" → null. Así el mapper y las
 * consultas dan lo mismo también en casos raros (tabuladores, " ~null~ ").
 */
function textoComoSql(
  rec: MaximoCanonicalRecord | null,
  key: string,
): string | null {
  const text = str(rec, key)?.replace(ESPACIOS_ASCII, '') ?? '';
  return text === '' || text === '~null~' ? null : text;
}

/** Número decimal o científico, la misma expresión que `rawNumber` (erp-views). */
const NUMERO_SQL = /^[-+]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][-+]?[0-9]+)?$/;

/** O: número de un campo como lo lee el SQL; si el texto no es número, null. */
function numeroComoSql(
  rec: MaximoCanonicalRecord | null,
  key: string,
): number | null {
  const v = rec?.[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const text = textoComoSql(rec, key);
  return text !== null && NUMERO_SQL.test(text) ? Number(text) : null;
}

/**
 * O1/O3: CONTRACTREFNUM de la OC (la marca de "OC de contrato"): el de la
 * cabecera o, si no, el de la primera línea que lo traiga con valor. La
 * misma regla que el diagnóstico del 22-oct ("cabecera o líneas"; 132 OC de
 * contrato en 2026). En SQL: `maximoPoDeContrato`.
 */
export function contractRefNumOf(r: MaximoCanonicalRecord): string | null {
  for (const node of headerAndLines(r)) {
    const text = textoComoSql(node, 'CONTRACTREFNUM');
    if (text !== null) return text;
  }
  return null;
}

/** O1: PO.EXCHANGERATE (contra el dólar), como lo lee el SQL. */
export function exchangeRateOf(r: MaximoCanonicalRecord): number | null {
  return numeroComoSql(r, 'EXCHANGERATE');
}

/**
 * O3 (2026-10-26): comprador de la RQ = la fila de RFQSTATUS (de la cabecera
 * o de una línea) con CHANGEBY y el RFQSTATUSSEQ más alto (sin número al
 * final; empate, el CHANGEBY menor y luego la primera que llega). Su nombre
 * es el PERSON.DISPLAYNAME de la fila (su primera PERSON), salvo que esa
 * PERSON sea otra persona (PERSONID distinto). Misma regla en SQL:
 * `maximoRqBuyerJoin` (erp-views).
 */
export function rfqBuyerOf(r: MaximoCanonicalRecord): {
  buyer: MaximoRfqBuyerDto | null;
  rfqNums: string[];
} {
  const rows = headerAndLines(r).flatMap((node) => children(node, 'RFQSTATUS'));
  const rfqNums = [
    ...new Set(
      rows
        .map((row) => textoComoSql(row, 'RFQNUM'))
        .filter((n): n is string => n !== null),
    ),
  ].sort();
  let buyer: MaximoRfqBuyerDto | null = null;
  for (const row of rows) {
    const changedBy = textoComoSql(row, 'CHANGEBY');
    if (changedBy === null) continue;
    const seq = numeroComoSql(row, 'RFQSTATUSSEQ');
    // estrictamente mejor: en un empate completo gana la que llegó primero
    const better =
      buyer === null ||
      (seq ?? -Infinity) > (buyer.seq ?? -Infinity) ||
      ((seq ?? -Infinity) === (buyer.seq ?? -Infinity) &&
        changedBy < buyer.changedBy);
    if (!better) continue;
    const person = first(row, 'PERSON');
    const personId = textoComoSql(person, 'PERSONID');
    const samePerson =
      personId === null || personId.toUpperCase() === changedBy.toUpperCase();
    buyer = {
      rfqNum: textoComoSql(row, 'RFQNUM'),
      changedBy,
      displayName: samePerson ? textoComoSql(person, 'DISPLAYNAME') : null,
      seq,
    };
  }
  return { buyer, rfqNums };
}

// ---------------------------------------------------------------------------
// Sub-mapeos compartidos
// ---------------------------------------------------------------------------

interface StatusRow<T extends MaximoStatusChangeDto> {
  dto: T;
  /** Id monótono de la fila de Maximo (desempate de CHANGEDATE). */
  id: number | null;
}

/**
 * Orden de cualquier historial de estatus: CHANGEDATE ascendente (nulos al
 * final). Maximo NO devuelve las filas ordenadas (86/100 POs de la evidencia
 * llegan desordenados) y hay cambios en el mismo segundo: el desempate es el
 * id monótono de la fila (POSTATUSID / CONTRACTSTATUSID / PRSTATUSID).
 * H11: el comparador es común con el detalle de contrato.
 */
function orderStatusRows<T extends MaximoStatusChangeDto>(
  rows: StatusRow<T>[],
): T[] {
  return [...rows]
    .sort((a, b) =>
      compareStatusChange(
        { changeDate: a.dto.changeDate, id: a.id },
        { changeDate: b.dto.changeDate, id: b.id },
      ),
    )
    .map((row) => row.dto);
}

/** Campos comunes de una fila de historial; null si no trae STATUS. */
function statusRowOf(
  row: MaximoCanonicalRecord,
): StatusRow<MaximoStatusChangeDto> | null {
  const status = str(row, 'STATUS');
  if (status === null) return null;
  return {
    dto: {
      status,
      changeDate: str(row, 'CHANGEDATE'),
      changedBy: str(row, 'CHANGEBY'),
    },
    id:
      num(row, 'POSTATUSID') ??
      num(row, 'CONTRACTSTATUSID') ??
      num(row, 'PRSTATUSID'),
  };
}

/** Historial de estatus de la OC (POSTATUS) o del contrato (CONTRACTSTATUS). */
function mapStatusHistory(
  rows: MaximoCanonicalRecord[],
): MaximoStatusChangeDto[] {
  return orderStatusRows(
    rows
      .map(statusRowOf)
      .filter((row): row is StatusRow<MaximoStatusChangeDto> => row !== null),
  );
}

/**
 * K3 (2026-10-05): historial PRSTATUS de la PR (hijo de la raíz de
 * AB_CONTRATOS), con el mismo orden que los demás historiales más el MEMO de
 * cada cambio (p. ej. el motivo de la cancelación). MEMO en blanco → null.
 */
function mapPrStatusHistory(
  rows: MaximoCanonicalRecord[],
): MaximoPrStatusChangeDto[] {
  const out: StatusRow<MaximoPrStatusChangeDto>[] = [];
  for (const row of rows) {
    const base = statusRowOf(row);
    if (!base) continue;
    const memo = str(row, 'MEMO');
    out.push({
      dto: { ...base.dto, memo: memo && memo.trim() !== '' ? memo : null },
      id: base.id,
    });
  }
  return orderStatusRows(out);
}

/**
 * K3: primer / último cambio CON FECHA al estatus indicado (historial ya
 * ordenado; las filas sin CHANGEDATE van al final y no cuentan, para que la
 * fecha y el usuario salgan siempre de la misma fila).
 */
function firstDatedChange<T extends MaximoStatusChangeDto>(
  history: T[],
  status: string,
): T | null {
  return (
    history.find((h) => h.status === status && h.changeDate !== null) ?? null
  );
}

function lastDatedChange<T extends MaximoStatusChangeDto>(
  history: T[],
  status: string,
): T | null {
  return (
    history.findLast((h) => h.status === status && h.changeDate !== null) ??
    null
  );
}

/** Primera fecha de cambio con el estatus indicado (historial ya ordenado). */
function firstChangeDate(
  history: MaximoStatusChangeDto[],
  status: string,
): string | null {
  return history.find((h) => h.status === status)?.changeDate ?? null;
}

/** Usuario (CHANGEBY) del primer cambio al estatus indicado: quién aprobó. */
function firstChangeBy(
  history: MaximoStatusChangeDto[],
  status: string,
): string | null {
  return history.find((h) => h.status === status)?.changedBy ?? null;
}

/**
 * Solo campos de negocio de PERSON. PERSON.STATUS / STATUSDATE / SUPERVISOR /
 * etc. se ignoran a propósito (PERSON.STATUS es el estatus de la persona).
 */
function mapPerson(
  person: MaximoCanonicalRecord | null,
): MaximoPersonDto | null {
  if (!person) return null;
  return {
    personId: str(person, 'PERSONID'),
    displayName: str(person, 'DISPLAYNAME'),
    department: str(person, 'DEPARTMENT'),
  };
}

/**
 * E4 (2026-09-25): nombre del comprador de la OC. En AB_COMPRAS la PERSON de
 * la OC es la del PURCHASEAGENT (validado en los fixtures reales: mismo
 * PERSONID); solo se toma su DISPLAYNAME si coincide, para no nombrar a
 * otra persona si algún día la relación cambia.
 */
function purchaseAgentName(
  agent: string | null,
  person: MaximoPersonDto | null,
): string | null {
  if (!agent || !person?.personId || !person.displayName) return null;
  return person.personId.toUpperCase() === agent.toUpperCase()
    ? person.displayName
    : null;
}

function mapVendor(
  company: MaximoCanonicalRecord | null,
): MaximoVendorDto | null {
  if (!company) return null;
  return {
    company: str(company, 'COMPANY'),
    name: str(company, 'NAME'),
    orgId: str(company, 'ORGID'),
  };
}

// ---------------------------------------------------------------------------
// AB_COMPRAS → MaximoPurchaseOrderDto
// ---------------------------------------------------------------------------

function mapPurchaseRequestRef(
  prline: MaximoCanonicalRecord | null,
  prnumFromLine: string | null,
): MaximoPurchaseRequestRefDto | null {
  const pr = first(prline, 'PR');
  const prnum = prnumFromLine ?? str(prline, 'PRNUM') ?? str(pr, 'PRNUM');
  if (!pr && !prnum) return null;
  return {
    prnum,
    requestedBy: str(pr, 'REQUESTEDBY'),
    issueDate: str(pr, 'ISSUEDATE'),
    statusDate: str(pr, 'STATUSDATE'),
  };
}

function mapPurchaseOrderLine(
  line: MaximoCanonicalRecord,
): MaximoPurchaseOrderLineDto {
  const item = first(line, 'ITEM');
  const prline = first(line, 'PRLINE');
  const prnum = str(line, 'PRNUM') ?? str(prline, 'PRNUM');
  return {
    lineNum: num(line, 'POLINENUM'),
    itemNum: str(line, 'ITEMNUM') ?? str(item, 'ITEMNUM'),
    itemDescription: str(item, 'DESCRIPTION') ?? str(line, 'DESCRIPTION'),
    enterDate: str(line, 'ENTERDATE'),
    prnum,
    pr: mapPurchaseRequestRef(prline, prnum),
    receiptsComplete: flag(line, 'RECEIPTSCOMPLETE'),
    receivedQty: num(line, 'RECEIVEDQTY'),
    lineCost: num(line, 'LINECOST'),
  };
}

/**
 * K3 (2026-10-05): líneas por POLINENUM ascendente, sin número al final.
 * Maximo no garantiza el orden de POLINE y de la primera línea salen `prnum`,
 * `requestedBy` y `prStatusDate` de la OC. El sort es estable: dos líneas sin
 * número conservan el orden de llegada.
 */
function sortLinesByNum(
  lines: MaximoPurchaseOrderLineDto[],
): MaximoPurchaseOrderLineDto[] {
  return [...lines].sort((a, b) => {
    if (a.lineNum === b.lineNum) return 0;
    if (a.lineNum === null) return 1;
    if (b.lineNum === null) return -1;
    return a.lineNum - b.lineNum;
  });
}

/**
 * K6 (2026-10-05): subtotal sin IVA de la OC = suma de POLINE.LINECOST
 * redondeada a 2 decimales, en la moneda de la OC. null si no hay líneas o a
 * alguna le falta LINECOST: no se estima con PRETAXTOTAL (Isaac: no es
 * persistente) ni con TOTALCOST/1.16.
 */
export function subtotalOf(lines: MaximoPurchaseOrderLineDto[]): number | null {
  if (lines.length === 0) return null;
  let sum = 0;
  for (const line of lines) {
    if (line.lineCost === null) return null;
    sum += line.lineCost;
  }
  return Math.round(sum * 100) / 100;
}

/**
 * K2 (2026-10-05): estado de integración con SAP = PO.PO5 literal, recortado
 * y en mayúsculas (PROCESADO, ACTUALIZAR, ERROR, AGREGAR…); vacío → null. Se
 * guarda sin interpretar: las etiquetas viven en Expeditación y en el front.
 */
function integrationStatusOf(header: MaximoCanonicalRecord): string | null {
  const po5 = str(header, 'PO5')?.trim().toUpperCase() ?? '';
  return po5 === '' ? null : po5;
}

/** Bandera de Maximo ("1"/"0", true/false, "Y"/"N"); null si no viene. */
function flag(rec: MaximoCanonicalRecord | null, key: string): boolean | null {
  const v = rec?.[key];
  if (typeof v === 'boolean') return v;
  const text = str(rec, key);
  if (text === null || text.trim() === '') return null;
  return ['1', 'TRUE', 'Y', 'YES'].includes(text.trim().toUpperCase());
}

/**
 * I1b (2026-09-30): recepción de la OC. RECEIPTS de la cabecera si viene
 * (NONE / PARTIAL / COMPLETE); si solo llega por línea, se deriva de
 * POLINE.RECEIPTSCOMPLETE / RECEIVEDQTY. AB_COMPRAS trae RECEIPTS en todas
 * las OC desde el 2-oct; sin cabecera ni líneas con dato → null.
 */
export function receiptStatusOf(
  header: MaximoCanonicalRecord | null,
  lines: MaximoPurchaseOrderLineDto[],
): string | null {
  const receipts = str(header, 'RECEIPTS');
  if (receipts && receipts.trim() !== '') return receipts.trim().toUpperCase();
  const known = lines.filter(
    (l) => l.receiptsComplete !== null || l.receivedQty !== null,
  );
  if (known.length === 0) return null;
  if (lines.every((l) => l.receiptsComplete === true)) return 'COMPLETE';
  if (
    lines.some((l) => l.receiptsComplete === true || (l.receivedQty ?? 0) > 0)
  ) {
    return 'PARTIAL';
  }
  return 'NONE';
}

/** Mapea un registro crudo de AB_COMPRAS (cualquier forma) al DTO interno. */
export function toPurchaseOrder(raw: unknown): MaximoPurchaseOrderDto {
  const r = toCanonical(raw);
  const ponum = str(r, 'PONUM');
  if (!ponum) throw new MaximoMappingError('PONUM ausente', 'PONUM');

  const history = mapStatusHistory(children(r, 'POSTATUS'));
  const buyerPerson = first(r, 'PERSON');
  // K3: ordenadas ANTES de derivar la PR de la OC (primera línea por número).
  const lines = sortLinesByNum(children(r, 'POLINE').map(mapPurchaseOrderLine));
  const firstPr = lines.find((l) => l.pr !== null)?.pr ?? null;
  // G2/G3 (2026-09-28): todas las PR de la OC y la fecha de la más antigua
  // (la gestión empieza con la primera solicitud; misma regla que SAP D3).
  const prNums = [
    ...new Set(
      lines.map((l) => l.prnum).filter((p): p is string => !!p && p !== ''),
    ),
  ].sort();
  const prIssueDates = lines
    .map((l) => l.pr?.issueDate ?? null)
    .filter((d): d is string => d !== null && !Number.isNaN(Date.parse(d)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  // O3: comprador de la RQ (RFQSTATUS, CIISA 26-oct)
  const rfq = rfqBuyerOf(r);

  return {
    erp: MAXIMO_ERP,
    ponum,
    siteId: str(r, 'SITEID'),
    revisionNum: num(r, 'REVISIONNUM'),
    status: str(r, 'STATUS'),
    description: str(r, 'DESCRIPTION'),

    orderDate: str(r, 'ORDERDATE'),
    approvedDate: firstChangeDate(history, 'APPR'),
    approvedBy: firstChangeBy(history, 'APPR'),
    waitingApprovalDate: firstChangeDate(history, 'WAPPR'),
    // F1: quien creó la OC y la mandó a aprobación (respaldo del comprador:
    // en prod solo 11 de 5,008 OC traen PURCHASEAGENT)
    createdBy: history[0]?.changedBy ?? null,
    statusHistory: history,

    vendorDeliveryDate: str(r, 'VENDELIVERYDATE'),
    currencyCode: str(r, 'CURRENCYCODE'),
    pretaxTotal: num(r, 'PRETAXTOTAL'),
    totalCost: num(r, 'TOTALCOST'),
    subtotal: subtotalOf(lines),
    integrationStatus: integrationStatusOf(r),

    abAhorro: num(r, 'AB_AHORRO'),
    abTipoComp: str(r, 'AB_TIPOCOMP'),
    abClasfPo: str(r, 'AB_CLASFPO'),
    purchaseAgent: str(r, 'PURCHASEAGENT'),
    purchaseAgentName: purchaseAgentName(
      str(r, 'PURCHASEAGENT'),
      mapPerson(buyerPerson),
    ),
    // O1/O3 (2026-10-26): sin columna; en SQL se leen del raw (erp-views)
    rfqBuyer: rfq.buyer,
    rfqNums: rfq.rfqNums,
    exchangeRate: exchangeRateOf(r),
    contractRefNum: contractRefNumOf(r),

    area: str(buyerPerson, 'DEPARTMENT'),
    buyer: mapPerson(buyerPerson),
    vendor: mapVendor(first(r, 'COMPANIES')),

    prnum: firstPr?.prnum ?? lines.find((l) => l.prnum !== null)?.prnum ?? null,
    requestedBy: firstPr?.requestedBy ?? null,
    prIssueDate: prIssueDates[0] ?? null,
    prNums,
    prStatusDate: firstPr?.statusDate ?? null,
    receiptStatus: receiptStatusOf(r, lines),

    lines,
    rowstamp: str(r, 'ROWSTAMP'),
  };
}

// ---------------------------------------------------------------------------
// AB_CONTRATOS → MaximoContractDto
// ---------------------------------------------------------------------------

function mapContractLine(line: MaximoCanonicalRecord): MaximoContractLineDto {
  const item = first(line, 'ITEM');
  return {
    lineNum: num(line, 'CONTRACTLINENUM'),
    itemNum: str(line, 'ITEMNUM') ?? str(item, 'ITEMNUM'),
    // Estructura actual: CONTRACTLINE.DESCRIPTION; previa: ITEM.DESCRIPTION.
    description: str(line, 'DESCRIPTION') ?? str(item, 'DESCRIPTION'),
  };
}

/**
 * Selección cuando un PR trae varias PURCHVIEW (revisiones del contrato):
 * se toma la de mayor REVISIONNUM (la vigente) y `purchviewCount` expone la
 * multiplicidad para que Int-3 detecte el truncamiento. La evidencia v1
 * muestra contratos con 2-4 revisiones; en la estructura PR-root actual solo
 * se ha observado una por PR (decisión definitiva pendiente para Int-3).
 */
function pickLatestPurchview(
  purchviews: MaximoCanonicalRecord[],
): MaximoCanonicalRecord | null {
  let best: MaximoCanonicalRecord | null = null;
  let bestRev = Number.NEGATIVE_INFINITY;
  for (const pv of purchviews) {
    const rev = num(pv, 'REVISIONNUM') ?? Number.NEGATIVE_INFINITY;
    if (best === null || rev > bestRev) {
      best = pv;
      bestRev = rev;
    }
  }
  return best;
}

interface ContractParts {
  root: MaximoCanonicalRecord;
  pr: MaximoCanonicalRecord | null;
  purchviews: MaximoCanonicalRecord[];
}

/** Canonicaliza y separa raíz PR / PURCHVIEW[] (ambas estructuras). */
function splitContractRecord(raw: unknown): ContractParts {
  const r = toCanonical(raw);
  const purchviewRoot =
    !hasKey(r, 'PRNUM') &&
    (hasKey(r, 'CONTRACTNUM') ||
      hasKey(r, 'CONTRACTLINE') ||
      hasKey(r, 'CONTRACTSTATUS'));

  const pr = purchviewRoot ? null : r;
  const purchviews = purchviewRoot ? [r] : children(r, 'PURCHVIEW');
  if (!pr && purchviews.length === 0) {
    throw new MaximoMappingError('ni PRNUM ni PURCHVIEW presentes', 'PRNUM');
  }
  if (pr && !str(pr, 'PRNUM')) {
    throw new MaximoMappingError('PRNUM ausente', 'PRNUM');
  }
  return { root: r, pr, purchviews };
}

/**
 * Mapea un registro crudo de AB_CONTRATOS (cualquier forma) al DTO interno.
 * Acepta la raíz PR actual (con o sin PURCHVIEW) y la raíz PURCHVIEW de la
 * estructura previa (evidencia v1). Con varias PURCHVIEW mapea la de mayor
 * REVISIONNUM (usar `toContracts` para obtener TODAS las revisiones — T3).
 */
export function toContract(raw: unknown): MaximoContractDto {
  const parts = splitContractRecord(raw);
  return buildContractDto(
    parts,
    pickLatestPurchview(parts.purchviews),
    parts.purchviews.length,
  );
}

/**
 * T3 (staging una fila por revisión): mapea un registro crudo de AB_CONTRATOS
 * a UN DTO POR PURCHVIEW (revisión). Sin PURCHVIEW → un único DTO con
 * `hasContract=false`. Cada DTO lleva el `purchviewCount` TOTAL del registro.
 */
export function toContracts(raw: unknown): MaximoContractDto[] {
  const parts = splitContractRecord(raw);
  if (parts.purchviews.length === 0) {
    return [buildContractDto(parts, null, 0)];
  }
  return parts.purchviews.map((pv) =>
    buildContractDto(parts, pv, parts.purchviews.length),
  );
}

/**
 * Bloque 2026-09-23 (D8): llaves candidatas del consumido del contrato en
 * PURCHVIEW (Maximo las nombra distinto según versión/vista). Se toma la
 * primera presente con valor numérico; ninguna → null (nunca 0).
 */
const CONSUMED_KEYS = [
  'RELEASEDTOTAL',
  'RELEASEDCOST',
  'TOTALRELEASED',
  'COMMITTED',
  'COMMITTEDTOTAL',
  'INVOICEDTOTAL',
  'TOTALINVOICED',
] as const;

function firstNum(
  rec: MaximoCanonicalRecord | null,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    if (hasKey(rec, key)) {
      const value = num(rec, key);
      if (value !== null) return value;
    }
  }
  return null;
}

/** D7: monto de la PR — cabecera o, si no viene, suma de PRLINE.LINECOST. */
function prTotalOf(pr: MaximoCanonicalRecord | null): number | null {
  const header = firstNum(pr, ['TOTALCOST', 'PRCOST', 'TOTALBASECOST']);
  if (header !== null) return header;
  const lines = children(pr, 'PRLINE');
  const costs = lines
    .map((line) => firstNum(line, ['LINECOST', 'LOADEDCOST']))
    .filter((c): c is number => c !== null);
  if (costs.length === 0) return null;
  return Math.round(costs.reduce((sum, c) => sum + c, 0) * 100) / 100;
}

/**
 * D2 / K3: estatus de la PR = STATUS de su raíz (nunca PERSON.STATUS, que es
 * un hijo). PRSTATUS ya no es respaldo: desde el 2-oct es el hijo historial.
 */
function prStatusOf(pr: MaximoCanonicalRecord | null): string | null {
  return str(pr, 'STATUS');
}

function buildContractDto(
  parts: ContractParts,
  pv: MaximoCanonicalRecord | null,
  purchviewCount: number,
): MaximoContractDto {
  const { root: r, pr } = parts;
  const prnum = pr ? str(pr, 'PRNUM') : null;
  const requesterPerson = first(pr, 'PERSON');
  const history = mapStatusHistory(children(pv, 'CONTRACTSTATUS'));
  const createdDate = firstChangeDate(history, 'WAPPR');
  const prStatus = prStatusOf(pr);
  // K3 (2026-10-05): campos de la PR (raíz de AB_CONTRATOS); se repiten igual
  // en cada revisión del contrato. APPR = llegada a Compras: la PRIMERA (no se
  // mueve si la PR regresa a WAPPR y se re-aprueba). CLOSE y CAN, la ÚLTIMA.
  // La CAN sale solo del historial (sin respaldo por STATUSDATE) y no se
  // infiere APPR cuando falta.
  const prHistory = mapPrStatusHistory(children(pr, 'PRSTATUS'));
  const prApproved = firstDatedChange(prHistory, 'APPR');
  const prCancelled = lastDatedChange(prHistory, 'CAN');

  // §20.2 RESUELTA (Isaac, correo 2026-09; registrado en HANDOFF 2026-09-21):
  // CONTRACTVALUE ≡ TOTALCOST y CONTRACTREFNUM ≡ CONTRACTNUM. Si algún día la
  // Object Structure expusiera los nombres literales, esos tienen precedencia;
  // mientras, se derivan de los campos equivalentes del PURCHVIEW.
  const contractRefNum = hasKey(pv, 'CONTRACTREFNUM')
    ? str(pv, 'CONTRACTREFNUM')
    : hasKey(pr, 'CONTRACTREFNUM')
      ? str(pr, 'CONTRACTREFNUM')
      : str(pv, 'CONTRACTNUM');
  const contractValue = hasKey(pv, 'CONTRACTVALUE')
    ? num(pv, 'CONTRACTVALUE')
    : hasKey(pr, 'CONTRACTVALUE')
      ? num(pr, 'CONTRACTVALUE')
      : num(pv, 'TOTALCOST');

  return {
    erp: MAXIMO_ERP,
    expenseType: MAXIMO_CONTRACT_EXPENSE_TYPE,

    prnum,
    siteId: str(pr, 'SITEID') ?? str(pv, 'SITEID'),
    requestedBy: str(pr, 'REQUESTEDBY'),
    area: str(requesterPerson, 'DEPARTMENT'),
    requester: mapPerson(requesterPerson),

    hasContract: pv !== null,
    purchviewCount,
    contractNum: str(pv, 'CONTRACTNUM'),
    contractRefNum,
    contractValue,
    orgId: str(pv, 'ORGID'),
    revisionNum: num(pv, 'REVISIONNUM'),
    currencyCode: str(pv, 'CURRENCYCODE'),
    startDate: str(pv, 'STARTDATE'),
    endDate: str(pv, 'ENDDATE'),
    maxVol: num(pv, 'MAXVOL'),
    totalCost: num(pv, 'TOTALCOST'),
    consumedValue: firstNum(pv, CONSUMED_KEYS),
    prTotal: prTotalOf(pr),
    prStatus,
    prIssueDate: str(pr, 'ISSUEDATE'),
    prStatusDate: str(pr, 'STATUSDATE'),
    prStatusHistory: prHistory,
    prApprovedDate: prApproved?.changeDate ?? null,
    prApprovedBy: prApproved?.changedBy ?? null,
    prClosedDate: lastDatedChange(prHistory, 'CLOSE')?.changeDate ?? null,
    prCancelledDate: prCancelled?.changeDate ?? null,
    prCancelledBy: prCancelled?.changedBy ?? null,

    // Último estatus del CONTRATO (historial ordenado). Sin contrato, el de
    // la PR (STATUS de su raíz). Nunca PERSON.STATUS.
    status: history.length
      ? history[history.length - 1].status
      : pv === null
        ? prStatus
        : null,
    statusHistory: history,
    createdDate,
    createdDateRule: createdDate !== null ? 'WAPPR' : null,
    approvedDate: firstChangeDate(history, 'APPR'),
    approvedBy: firstChangeBy(history, 'APPR'),

    vendor: mapVendor(first(pv, 'COMPANIES')),
    lines: children(pv, 'CONTRACTLINE').map(mapContractLine),
    rowstamp: str(r, 'ROWSTAMP'),
    contractRowstamp: str(pv, 'ROWSTAMP'),
  };
}

// ---------------------------------------------------------------------------
// Sobres (envelopes)
// ---------------------------------------------------------------------------

export interface MaximoLegacyPageInfo {
  rsStart: number | null;
  rsCount: number | null;
  /** Solo en listados sin filtro. */
  rsTotal: number | null;
}

export interface MaximoOslcPageInfo {
  /** Solo con `collectioncount=1` (no validado en prod). */
  totalCount: number | null;
  /** Presente cuando hay más páginas (no validado en prod). */
  nextPageHref: string | null;
  pageNum: number | null;
}

function intOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Extrae los registros raíz (PO / PR / PURCHVIEW) y los contadores del sobre
 * legacy `{ Query<OS>Response: { rsStart, rsCount, rsTotal, <OS>Set: { … } } }`.
 * Un conjunto vacío llega como `<OS>Set: {}` → `records: []`.
 */
export function parseLegacyEnvelope(
  body: unknown,
  objectStructure: MaximoObjectStructure,
): { records: unknown[]; page: MaximoLegacyPageInfo } {
  const responseKey = `Query${objectStructure}Response`;
  if (!isPlainObject(body) || !isPlainObject(body[responseKey])) {
    throw new MaximoResponseShapeError(`falta ${responseKey}`);
  }
  const response = body[responseKey];
  const set = response[`${objectStructure}Set`];
  const records: unknown[] = [];
  if (isPlainObject(set)) {
    for (const value of Object.values(set)) {
      if (Array.isArray(value)) records.push(...value.filter(isPlainObject));
    }
  }
  return {
    records,
    page: {
      rsStart: intOrNull(response.rsStart),
      rsCount: intOrNull(response.rsCount),
      rsTotal: intOrNull(response.rsTotal),
    },
  };
}

/** Extrae `member[]` y `responseInfo` del sobre OSLC; un `{ Error }` lanza. */
export function parseOslcEnvelope(body: unknown): {
  records: unknown[];
  page: MaximoOslcPageInfo;
} {
  if (!isPlainObject(body)) {
    throw new MaximoResponseShapeError('el cuerpo OSLC no es un objeto');
  }
  if (isPlainObject(body.Error)) {
    const reasonCode =
      typeof body.Error.reasonCode === 'string' ? body.Error.reasonCode : null;
    const message =
      typeof body.Error.message === 'string'
        ? body.Error.message
        : 'Error OSLC';
    throw new MaximoResponseShapeError(message, reasonCode);
  }
  if (!Array.isArray(body.member)) {
    throw new MaximoResponseShapeError('falta member[]');
  }
  const info = isPlainObject(body.responseInfo) ? body.responseInfo : null;
  const nextPage = info && isPlainObject(info.nextPage) ? info.nextPage : null;
  return {
    records: body.member.filter(isPlainObject),
    page: {
      totalCount: intOrNull(info?.totalCount),
      nextPageHref:
        nextPage && typeof nextPage.href === 'string' ? nextPage.href : null,
      pageNum: intOrNull(info?.pagenum),
    },
  };
}

/** Agrupador por conveniencia; todas son funciones puras. */
export const MaximoMapper = {
  toCanonical,
  toPurchaseOrder,
  toContract,
  toContracts,
  parseLegacyEnvelope,
  parseOslcEnvelope,
} as const;
