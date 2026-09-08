import {
  MAXIMO_CONTRACT_EXPENSE_TYPE,
  MaximoContractDto,
  MaximoContractLineDto,
} from './dto/maximo-contract.dto';
import {
  MAXIMO_ERP,
  MaximoPersonDto,
  MaximoPurchaseOrderDto,
  MaximoPurchaseOrderLineDto,
  MaximoPurchaseRequestRefDto,
  MaximoStatusChangeDto,
  MaximoVendorDto,
} from './dto/maximo-po.dto';
import {
  MaximoCanonicalRecord,
  MaximoObjectStructure,
  MaximoRawScalar,
} from './dto/maximo-raw.types';
import { MaximoMappingError, MaximoResponseShapeError } from './maximo.errors';

/**
 * Versión del mapper. Se persiste por fila de staging (Int-3): permite saber
 * qué reglas produjeron las columnas mapeadas y re-mapear (`maximo:remap`)
 * cuando cambien (p. ej. cuando Isaac confirme CONTRACTREFNUM/APPR1..4).
 * Subirla en CADA cambio de reglas de mapeo.
 */
export const MAXIMO_MAPPER_VERSION = '2026.08.31-1';

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

const NULL_TOKEN = '~null~';
const OSLC_META_KEYS = new Set(['href', 'localref']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Desenvuelve `{ content: X }`, `"~null~"` y tipos no escalares → null. */
function unwrapScalar(value: unknown): MaximoRawScalar {
  if (isPlainObject(value)) {
    return 'content' in value ? unwrapScalar(value.content) : null;
  }
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value === NULL_TOKEN ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

/**
 * Normaliza un registro de cualquiera de las tres formas. Claves UPPERCASE,
 * escalares desenvueltos, hijos como arrays canónicos, `rowstamp`/`_rowstamp`
 * → `ROWSTAMP`, metadatos OSLC descartados.
 */
export function toCanonical(raw: unknown): MaximoCanonicalRecord {
  if (!isPlainObject(raw)) {
    throw new MaximoMappingError('el registro no es un objeto', '$');
  }
  const out: MaximoCanonicalRecord = {};

  // Forma 1: legacy anidado (Attributes / RelatedMbos)
  const attrs = raw.Attributes;
  const related = raw.RelatedMbos;
  if (isPlainObject(attrs) || isPlainObject(related)) {
    if (typeof raw.rowstamp === 'string') out.ROWSTAMP = raw.rowstamp;
    if (isPlainObject(attrs)) {
      for (const [key, value] of Object.entries(attrs)) {
        out[key.toUpperCase()] = unwrapScalar(value);
      }
    }
    if (isPlainObject(related)) {
      for (const [key, value] of Object.entries(related)) {
        if (Array.isArray(value)) {
          out[key.toUpperCase()] = value.filter(isPlainObject).map(toCanonical);
        }
      }
    }
    return out;
  }

  // Formas 2 (legacy compacto) y 3 (OSLC lean)
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    if (OSLC_META_KEYS.has(lower) || lower.endsWith('_collectionref')) continue;
    const name =
      lower === '_rowstamp' || lower === 'rowstamp'
        ? 'ROWSTAMP'
        : key.toUpperCase();
    if (Array.isArray(value)) {
      out[name] = value.filter(isPlainObject).map(toCanonical);
      continue;
    }
    out[name] = unwrapScalar(value);
  }
  return out;
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

// ---------------------------------------------------------------------------
// Sub-mapeos compartidos
// ---------------------------------------------------------------------------

/**
 * Historial de estatus ordenado por CHANGEDATE ascendente (nulos al final).
 * Maximo NO devuelve las filas ordenadas (86/100 POs de la evidencia llegan
 * desordenados) y hay cambios en el mismo segundo: el desempate es el id
 * monótono de la fila (POSTATUSID / CONTRACTSTATUSID).
 */
function mapStatusHistory(
  rows: MaximoCanonicalRecord[],
): MaximoStatusChangeDto[] {
  return rows
    .map((row) => ({
      dto: {
        status: str(row, 'STATUS'),
        changeDate: str(row, 'CHANGEDATE'),
        changedBy: str(row, 'CHANGEBY'),
      },
      id: num(row, 'POSTATUSID') ?? num(row, 'CONTRACTSTATUSID'),
    }))
    .filter(
      (row): row is { dto: MaximoStatusChangeDto; id: number | null } =>
        row.dto.status !== null,
    )
    .sort((a, b) => {
      const da = a.dto.changeDate;
      const db = b.dto.changeDate;
      if (da !== db) {
        if (da === null) return 1;
        if (db === null) return -1;
        if (da !== db) return da < db ? -1 : 1;
      }
      if (a.id !== null && b.id !== null && a.id !== b.id) {
        return a.id - b.id;
      }
      return 0;
    })
    .map((row) => row.dto);
}

/** Primera fecha de cambio con el estatus indicado (historial ya ordenado). */
function firstChangeDate(
  history: MaximoStatusChangeDto[],
  status: string,
): string | null {
  return history.find((h) => h.status === status)?.changeDate ?? null;
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
  };
}

/** Mapea un registro crudo de AB_COMPRAS (cualquier forma) al DTO interno. */
export function toPurchaseOrder(raw: unknown): MaximoPurchaseOrderDto {
  const r = toCanonical(raw);
  const ponum = str(r, 'PONUM');
  if (!ponum) throw new MaximoMappingError('PONUM ausente', 'PONUM');

  const history = mapStatusHistory(children(r, 'POSTATUS'));
  const buyerPerson = first(r, 'PERSON');
  const lines = children(r, 'POLINE').map(mapPurchaseOrderLine);
  const firstPr = lines.find((l) => l.pr !== null)?.pr ?? null;

  return {
    erp: MAXIMO_ERP,
    ponum,
    siteId: str(r, 'SITEID'),
    revisionNum: num(r, 'REVISIONNUM'),
    status: str(r, 'STATUS'),
    description: str(r, 'DESCRIPTION'),

    orderDate: str(r, 'ORDERDATE'),
    approvedDate: firstChangeDate(history, 'APPR'),
    waitingApprovalDate: firstChangeDate(history, 'WAPPR'),
    statusHistory: history,

    vendorDeliveryDate: str(r, 'VENDELIVERYDATE'),
    currencyCode: str(r, 'CURRENCYCODE'),
    pretaxTotal: num(r, 'PRETAXTOTAL'),
    totalCost: num(r, 'TOTALCOST'),

    abAhorro: num(r, 'AB_AHORRO'),
    abTipoComp: str(r, 'AB_TIPOCOMP'),
    abClasfPo: str(r, 'AB_CLASFPO'),
    purchaseAgent: str(r, 'PURCHASEAGENT'),

    area: str(buyerPerson, 'DEPARTMENT'),
    buyer: mapPerson(buyerPerson),
    vendor: mapVendor(first(r, 'COMPANIES')),

    prnum: firstPr?.prnum ?? lines.find((l) => l.prnum !== null)?.prnum ?? null,
    requestedBy: firstPr?.requestedBy ?? null,
    prIssueDate: firstPr?.issueDate ?? null,
    prStatusDate: firstPr?.statusDate ?? null,

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

  // §20.2: CONTRACTREFNUM / CONTRACTVALUE solo si llegan con ese nombre
  // exacto (en PURCHVIEW o en la raíz PR). Hoy no llegan → null. Prohibido
  // derivarlos de MAXVOL / CONTRACTNUM hasta confirmación de Isaac.
  const contractRefNum = hasKey(pv, 'CONTRACTREFNUM')
    ? str(pv, 'CONTRACTREFNUM')
    : hasKey(pr, 'CONTRACTREFNUM')
      ? str(pr, 'CONTRACTREFNUM')
      : null;
  const contractValue = hasKey(pv, 'CONTRACTVALUE')
    ? num(pv, 'CONTRACTVALUE')
    : hasKey(pr, 'CONTRACTVALUE')
      ? num(pr, 'CONTRACTVALUE')
      : null;

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

    // Último estatus del CONTRATO (historial ordenado). Nunca PERSON.STATUS.
    status: history.length ? history[history.length - 1].status : null,
    statusHistory: history,
    createdDate,
    createdDateRule: createdDate !== null ? 'WAPPR' : null,
    approvedDate: firstChangeDate(history, 'APPR'),

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
