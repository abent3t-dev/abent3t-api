import { normalizeCompanyName } from '../erp-vendors/maximo-vendor-xref';
import {
  compactText,
  contractNumberFor,
  contractStatusFor,
  type ContractDocumentType,
  type ContractStatus,
  docKindLabel,
  docKindType,
  normalizeCarpeta,
  normalizeExcelStatus,
  normalizeUserArea,
  parseDocKind,
} from './contract-catalog';

export type { ContractDocumentType, ContractStatus } from './contract-catalog';

/**
 * H2 (2026-09-29) — Plan de la importación de contratos desde el Excel de
 * Diana (base depurada), separado del script para poder probarlo:
 *
 *  - Filas: columnas por nombre normalizado, con alias (el formato del
 *    21-sep más las columnas que traiga la base nueva: monto, moneda,
 *    consumido, link, tomo, tipo, correo del responsable).
 *  - Nuevos: contratos que no existen (se crean como siempre).
 *  - Actualizar (`--update`): campo por campo, SOLO si el archivo trae valor:
 *    el archivo nunca pisa con vacíos lo capturado en la UI (link, consumido,
 *    monto). Las notas no se reescriben: se agrega lo nuevo al final.
 *  - Sin cambios.
 *  - Faltantes: activos en la base que ya no vienen en el archivo →
 *    candidatos a baja. Los capturados en la plataforma (created_by) se
 *    marcan para revisar a mano y `--deactivate-missing` no los toca.
 *
 * I6 (go-live 2026-09-30) — la base REAL (Control_de_contratos_A3T.xlsx):
 *  - columnas "Núm. Carpeta", "Num. Tomo", "Tipo de documento", "Área
 *    usuaria", "Comprador", "Plazo", "Estatus" y "Nombre del archivo"; el
 *    número sale de carpeta + tipo (ver contract-catalog.ts);
 *  - fechas de texto `dd/mm/aaaa` con el día primero; "NA" o "." = vacío;
 *    la fecha de fin calculada con fórmula se toma sin la fracción del día;
 *  - sin fecha de fin se importa ("Sin fecha de fin", sin alertas) con el
 *    estatus del Excel normalizado o vigente;
 *  - filas vacías (solo carpeta y tomo) se saltan y se reportan;
 *  - proveedores: también sin la forma jurídica (`normalizeCompanyName` de
 *    G1) y las variantes del mismo proveedor dentro del archivo se unifican;
 *  - reporte para Diana: proveedores sin match, filas saltadas, montos sin
 *    moneda, fechas ilegibles, documentos sin fecha de fin y estatus del
 *    Excel que contradicen la fecha.
 *
 * Reglas de siempre: monto sin moneda no se importa (salvo `--moneda=XXX`
 * explícito); el "% disponible" no es un monto; estatus por fecha de fin.
 */

/** Una fila del Excel ya interpretada (null = la celda viene vacía). */
export interface ImportRow {
  rowNumber: number;
  number: string;
  /** I6: carpeta del control (A3T-0003); null en el formato del 21-sep. */
  carpeta: string | null;
  /** I6: tipo literal normalizado ("Enmienda 3", "Carta de intención"). */
  documentLabel: string | null;
  supplierName: string | null;
  service: string | null;
  startDate: Date | null;
  endDate: Date | null;
  realDate: Date | null;
  responsible: string | null;
  responsibleEmail: string | null;
  admin: string | null;
  documentRef: string | null;
  amount: number | null;
  currency: string | null;
  consumed: number | null;
  link: string | null;
  tomo: string | null;
  documentType: ContractDocumentType | null;
  /** I6: área usuaria (catálogo de 11 áreas). */
  userArea: string | null;
  /** I6: comprador por nombre (hoy viene vacío en toda la base). */
  buyer: string | null;
  /** I6: plazo literal ("12 meses", "PERMANENTE"); va a las notas. */
  term: string | null;
  /** I6: estatus capturado a mano (solo cuenta sin fecha de fin). */
  excelStatus: 'vigente' | 'vencido' | null;
}

export interface ExistingContract {
  id: string;
  contract_number: string;
  tomo: string | null;
  document_type: ContractDocumentType;
  service_description: string;
  supplier_id: string;
  supplier_name: string;
  start_date: Date | null;
  end_date: Date | null;
  total_amount: number | null;
  currency: string | null;
  consumed_amount: number | null;
  external_link: string | null;
  responsible_user_name: string | null;
  responsible_user_email: string | null;
  status: ContractStatus;
  notes: string | null;
  /** Capturado en la plataforma (no por un script de importación). */
  created_by: string | null;
  carpeta: string | null;
  document_label: string | null;
  user_area: string | null;
  buyer_profile_id: string | null;
  /** J2: vencido histórico (sin avisos). */
  vencido_historico?: boolean;
}

export interface SupplierIndexEntry {
  id: string;
  legal_name: string;
  key: string;
  /** Nombre sin forma jurídica (G1); se calcula si no viene. */
  norm?: string;
}

/** Comprador posible (perfil activo) para la columna "Comprador". */
export interface BuyerIndexEntry {
  id: string;
  full_name: string;
}

export type ContractField =
  | 'service_description'
  | 'supplier'
  | 'start_date'
  | 'end_date'
  | 'status'
  | 'responsible_user_name'
  | 'responsible_user_email'
  | 'total_amount'
  | 'currency'
  | 'consumed_amount'
  | 'external_link'
  | 'tomo'
  | 'document_type'
  | 'notes'
  | 'carpeta'
  | 'document_label'
  | 'user_area'
  | 'buyer_profile_id';

export interface FieldChange {
  field: ContractField;
  from: string | null;
  to: string;
}

/** Datos listos para escribir (proveedor por nombre si hay que darlo de alta). */
export interface ContractData {
  service_description?: string;
  supplier_id?: string;
  new_supplier_name?: string;
  start_date?: Date | null;
  end_date?: Date | null;
  status?: ContractStatus;
  responsible_user_name?: string;
  responsible_user_email?: string;
  total_amount?: number | null;
  currency?: string | null;
  consumed_amount?: number | null;
  external_link?: string;
  tomo?: string;
  document_type?: ContractDocumentType;
  notes?: string;
  carpeta?: string;
  document_label?: string;
  user_area?: string;
  buyer_profile_id?: string;
  /** J2: el que entra ya vencido es histórico (sin avisos). */
  vencido_historico?: boolean;
}

/** I6: lo que se le pasa a Diana después del dry-run. */
export interface ContractImportReport {
  /** Proveedores que no cuadran con el catálogo (se crean manuales). */
  newSuppliers: Array<{ name: string; variants: string[]; rows: string[] }>;
  /** Montos sin moneda (no se importan: nunca se inventa la moneda). */
  amountWithoutCurrency: string[];
  /** Documentos sin fecha de fin (sin alertas de vencimiento). */
  noEndDate: string[];
  /** Estatus del Excel que contradice la fecha de fin. */
  statusContradictions: Array<{
    ref: string;
    excel: string;
    byDate: ContractStatus;
    end: string;
  }>;
  /** Compradores que no cuadran con un usuario de la plataforma. */
  unmatchedBuyers: Array<{ ref: string; name: string }>;
}

export interface ContractImportPlan {
  create: Array<{
    row: ImportRow;
    data: ContractData & {
      contract_number: string;
      service_description: string;
      start_date: Date | null;
      end_date: Date | null;
      status: ContractStatus;
      document_type: ContractDocumentType;
    };
    supplierNote: string;
  }>;
  update: Array<{
    row: ImportRow;
    id: string;
    changes: FieldChange[];
    data: ContractData;
  }>;
  unchanged: string[];
  missing: Array<{
    id: string;
    contract_number: string;
    supplier_name: string;
    end_date: Date | null;
    fromPlatform: boolean;
  }>;
  /** Existentes en el archivo que no se revisaron (sin `--update`). */
  skipped: string[];
  warnings: string[];
  errors: string[];
  report: ContractImportReport;
}

export interface PlanOptions {
  today: Date;
  /** Revisar cambios de los existentes y listar faltantes. */
  update: boolean;
  /** Moneda para montos sin moneda (solo si se pide explícito). */
  defaultCurrency?: string | null;
  /** Encabezado de las notas de las altas (de qué archivo vienen). */
  importLabel?: string;
}

// ── Normalización ───────────────────────────────────────────────────────

/** Sin acentos, sin puntuación, sin espacios, mayúsculas. */
export function compact(value: string): string {
  return compactText(value);
}

/** Placeholder de RFC para proveedores sin RFC (tax_id UNIQUE). */
export function placeholderTaxId(name: string): string {
  return `SIN-RFC-${compact(name).slice(0, 30)}`.slice(0, 40);
}

/** Llave sin forma jurídica: "SAYFI SA DE CV" = "Sayfi". */
export function supplierNormKey(name: string): string {
  return normalizeCompanyName(name).replace(/ /g, '');
}

type HeaderField = Exclude<keyof ImportRow, 'rowNumber' | 'documentLabel'>;

/** Encabezados aceptados por campo (el formato del 21-sep va primero). */
const HEADERS: Record<HeaderField, string[]> = {
  number: ['Contrato', 'No. contrato', 'Número de contrato', 'Numero'],
  carpeta: [
    'Núm. Carpeta',
    'Num. Carpeta',
    'Carpeta',
    'No. carpeta',
    'Número de carpeta',
  ],
  supplierName: ['Proveedor', 'Razón social'],
  service: ['Descrip.', 'Descripción', 'Servicio'],
  startDate: ['Fecha Inicio', 'Inicio', 'Fecha de inicio'],
  endDate: ['Fecha Fin', 'Fin', 'Fecha de fin', 'Vencimiento'],
  realDate: ['Fecha real'],
  responsible: ['Resp. Usuario', 'Responsable', 'Responsable usuario'],
  responsibleEmail: [
    'Correo',
    'Correo responsable',
    'Email',
    'Email responsable',
  ],
  admin: ['Adm. de Contrato', 'Administrador', 'Administrador del contrato'],
  documentRef: ['Documento', 'Nombre del archivo', 'Archivo'],
  amount: [
    'Monto',
    'Monto total',
    'Monto Adjudicado',
    'Importe',
    'Valor',
    'Valor del contrato',
  ],
  currency: ['Moneda', 'Divisa'],
  consumed: ['Consumido', 'Monto consumido', 'Ejercido'],
  link: [
    'Link',
    'Liga',
    'URL',
    'Link SharePoint',
    'Liga SharePoint',
    'SharePoint',
  ],
  tomo: ['Tomo', 'Num. Tomo', 'Núm. Tomo', 'No. tomo'],
  documentType: ['Tipo', 'Tipo de documento'],
  userArea: ['Área usuaria', 'Área', 'Área responsable'],
  buyer: ['Comprador'],
  term: ['Plazo'],
  excelStatus: ['Estatus', 'Status', 'Estado'],
};

/**
 * I6: la hoja de los contratos es la que tiene los encabezados (Proveedor y
 * Carpeta o Contrato), no la primera ("Hoja2" son los catálogos y va antes).
 */
export function pickContractSheet(
  sheets: Array<{ name: string; headers: unknown[] }>,
): string | null {
  const has = (headers: unknown[], field: HeaderField) => {
    const keys = new Set(
      headers.filter((h) => typeof h === 'string').map((h) => compact(h)),
    );
    return HEADERS[field].some((h) => keys.has(compact(h)));
  };
  const found = sheets.find(
    (s) =>
      has(s.headers, 'supplierName') &&
      (has(s.headers, 'carpeta') || has(s.headers, 'number')),
  );
  return found?.name ?? null;
}

/** "NA", "N/A", "." o "-": la celda dice que no hay dato. */
function isNoData(text: string): boolean {
  const key = compact(text);
  return key === '' || key === 'NA' || key === 'NOAPLICA';
}

const DAY_MS = 86_400_000;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function utcDate(y: number, m: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
    ? date
    : null;
}

/**
 * Fecha de una celda. Serial de Excel (sin la fracción del día: la fecha de
 * fin con fórmula `I3+(12*30.6)` trae horas), Date (la de SheetJS viene en
 * la medianoche local), texto `dd/mm/aaaa` con el DÍA primero o ISO.
 * `unreadable` = había texto y no es fecha (se reporta).
 */
export function readExcelDate(value: unknown): {
  date: Date | null;
  unreadable: string | null;
} {
  if (value === null || value === undefined) {
    return { date: null, unreadable: null };
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return { date: null, unreadable: String(value) };
    }
    const utcMidnight =
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0;
    const date = utcMidnight
      ? utcDate(
          value.getUTCFullYear(),
          value.getUTCMonth() + 1,
          value.getUTCDate(),
        )
      : utcDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    return { date, unreadable: null };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 1 || value > 2_958_465) {
      return { date: null, unreadable: String(value) };
    }
    return {
      date: new Date(EXCEL_EPOCH + Math.floor(value + 1e-9) * DAY_MS),
      unreadable: null,
    };
  }
  if (typeof value !== 'string') {
    // booleano u objeto: no es fecha
    return { date: null, unreadable: JSON.stringify(value) ?? 'valor' };
  }
  const text = value.trim();
  if (isNoData(text)) return { date: null, unreadable: null };
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text);
  if (dmy) {
    const year = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    const date = utcDate(year, Number(dmy[2]), Number(dmy[1]));
    return date ? { date, unreadable: null } : { date: null, unreadable: text };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(text);
  if (iso) {
    const date = utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return date ? { date, unreadable: null } : { date: null, unreadable: text };
  }
  return { date: null, unreadable: text };
}

/** Fechas del Excel: serial, Date o texto `dd/mm/aaaa` (null = vacía o ilegible). */
export function parseExcelDate(value: unknown): Date | null {
  return readExcelDate(value).date;
}

/** "$1,234.50" → 1234.5; vacío, "NA", "." o texto → null. Un porcentaje NO es monto. */
export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.includes('%') || isNoData(text)) return null;
  const n = Number(text.replace(/[$\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** MXN / USD / EUR con los nombres que se usan en la oficina ("MXN ", "usd", "EUROS"). */
export function parseCurrency(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const key = compact(value);
  if (['MXN', 'MN', 'MXP', 'PESOS', 'PESO', 'PESOSMEXICANOS'].includes(key)) {
    return 'MXN';
  }
  if (['USD', 'DLS', 'DOLARES', 'DOLAR', 'US', 'USDLS'].includes(key))
    return 'USD';
  if (['EUR', 'EUROS', 'EURO'].includes(key)) return 'EUR';
  return key.length === 3 ? key : null;
}

export function parseDocumentType(value: unknown): ContractDocumentType | null {
  const parsed = parseDocKind(value);
  return parsed ? docKindType(parsed.kind) : null;
}

const isHttpUrl = (value: string) => /^https?:\/\/\S+$/i.test(value);

export interface NormalizeResult {
  rows: ImportRow[];
  warnings: string[];
  /** I6: filas vacías (solo carpeta y tomo): se saltan. */
  skipped: Array<{ rowNumber: number; ref: string }>;
  /** I6: fechas con texto que no se pudo leer (se importan vacías). */
  unreadableDates: Array<{
    rowNumber: number;
    ref: string;
    field: 'inicio' | 'fin' | 'fecha real';
    value: string;
  }>;
  /** I6: áreas fuera del catálogo (se guardan tal cual). */
  unknownAreas: Array<{ rowNumber: number; ref: string; value: string }>;
}

/** Registros del Excel (sheet_to_json) → filas; celdas vacías = null. */
export function normalizeContractRows(
  records: Array<Record<string, unknown>>,
): NormalizeResult {
  const result: NormalizeResult = {
    rows: [],
    warnings: [],
    skipped: [],
    unreadableDates: [],
    unknownAreas: [],
  };
  // I6: números ya usados en el archivo (el segundo contrato → -2)
  const taken = new Set<string>();
  records.forEach((record, index) => {
    const byKey = new Map(
      Object.entries(record).map(([k, v]) => [compact(k), v]),
    );
    const cell = (field: HeaderField): unknown => {
      for (const header of HEADERS[field]) {
        const value = byKey.get(compact(header));
        if (value !== undefined && value !== null && value !== '') return value;
      }
      return null;
    };
    const text = (field: HeaderField): string | null => {
      const value = cell(field);
      if (typeof value === 'string') return value.trim() || null;
      if (typeof value === 'number') return String(value);
      return null;
    };
    const rowNumber = index + 2; // 1 = encabezados
    const explicitNumber = text('number');
    const carpetaText = text('carpeta');
    const carpeta = normalizeCarpeta(carpetaText);
    const supplierName = text('supplierName');
    const service = text('service');
    if (!explicitNumber && !supplierName && !carpetaText) return; // fila vacía
    if (!supplierName && !service) {
      // I6: carpeta sin documento (A3T-0037, A3T-0160…): se reporta
      if (carpetaText) {
        result.skipped.push({
          rowNumber,
          ref: [carpeta ?? carpetaText, text('tomo')]
            .filter(Boolean)
            .join(' · '),
        });
      }
      return;
    }

    // Número: el de la columna (formato del 21-sep) o carpeta + tipo (I6)
    const kind = parseDocKind(cell('documentType'));
    let number = explicitNumber ?? '';
    let documentLabel: string | null = null;
    if (!explicitNumber && carpeta) {
      const k = kind ?? { kind: 'contrato' as const, n: null };
      if (!kind) {
        result.warnings.push(
          `Fila ${rowNumber} (${carpeta}): sin tipo de documento; se toma como Contrato`,
        );
      }
      number = contractNumberFor(carpeta, k.kind, k.n, (n) => taken.has(n));
      documentLabel = docKindLabel(k.kind, k.n);
    } else if (!explicitNumber && carpetaText) {
      result.warnings.push(
        `Fila ${rowNumber}: la carpeta "${carpetaText}" no tiene la forma A3T-0000`,
      );
    }
    if (number) taken.add(number);
    const ref = number || `fila ${rowNumber}`;

    let link = text('link');
    if (link && !isHttpUrl(link)) {
      result.warnings.push(
        `Fila ${rowNumber} (${number || 'sin número'}): el link no es una URL http(s); no se importa`,
      );
      link = null;
    }
    const date = (field: 'startDate' | 'endDate' | 'realDate') => {
      const read = readExcelDate(cell(field));
      if (read.unreadable !== null) {
        result.unreadableDates.push({
          rowNumber,
          ref,
          field:
            field === 'startDate'
              ? 'inicio'
              : field === 'endDate'
                ? 'fin'
                : 'fecha real',
          value: read.unreadable,
        });
      }
      return read.date;
    };
    const area = normalizeUserArea(cell('userArea'));
    if (!area.known && area.area) {
      result.unknownAreas.push({ rowNumber, ref, value: area.area });
    }
    const term = text('term');
    const email = text('responsibleEmail');
    result.rows.push({
      rowNumber,
      number,
      carpeta: explicitNumber ? null : carpeta,
      documentLabel,
      supplierName,
      service,
      startDate: date('startDate'),
      endDate: date('endDate'),
      realDate: date('realDate'),
      responsible: text('responsible'),
      responsibleEmail:
        email && email.includes('@') ? email.toLowerCase() : null,
      admin: text('admin'),
      documentRef: text('documentRef'),
      amount: parseAmount(cell('amount')),
      currency: parseCurrency(cell('currency')),
      consumed: parseAmount(cell('consumed')),
      link,
      tomo: text('tomo'),
      documentType: kind ? docKindType(kind.kind) : null,
      userArea: area.area,
      buyer: text('buyer'),
      term: term && !isNoData(term) ? term.replace(/\s+/g, ' ') : null,
      excelStatus: normalizeExcelStatus(cell('excelStatus')),
    });
  });
  return result;
}

// ── Proveedores ─────────────────────────────────────────────────────────

const normOf = (s: SupplierIndexEntry) =>
  s.norm ?? supplierNormKey(s.legal_name);

/**
 * Proveedor por nombre contra el índice en memoria: exacto compacto, luego
 * sin la forma jurídica (I6) y luego prefijo único (≥10 caracteres; los
 * nombres del Excel vienen truncados).
 */
export function matchSupplier(
  name: string,
  index: SupplierIndexEntry[],
): { entry: SupplierIndexEntry | null; ambiguous: string[] } {
  const key = compact(name);
  const exact = index.filter((s) => s.key === key);
  if (exact.length === 1) return { entry: exact[0], ambiguous: [] };
  if (exact.length > 1) {
    return { entry: null, ambiguous: exact.map((s) => s.legal_name) };
  }
  const norm = supplierNormKey(name);
  if (norm.length >= 3) {
    const byNorm = index.filter((s) => normOf(s) === norm);
    if (byNorm.length === 1) return { entry: byNorm[0], ambiguous: [] };
    if (byNorm.length > 1) {
      return { entry: null, ambiguous: byNorm.map((s) => s.legal_name) };
    }
  }
  const byPrefix = index.filter(
    (s) =>
      (key.length >= 10 && s.key.startsWith(key)) ||
      (s.key.length >= 10 && key.startsWith(s.key)),
  );
  if (byPrefix.length === 1) return { entry: byPrefix[0], ambiguous: [] };
  return { entry: null, ambiguous: byPrefix.map((s) => s.legal_name) };
}

/** Comprador por nombre: exacto (sin acentos) o prefijo único. */
export function matchBuyer(
  name: string,
  buyers: BuyerIndexEntry[],
): BuyerIndexEntry | null {
  const key = compact(name);
  if (key.length < 3) return null;
  const exact = buyers.filter((b) => compact(b.full_name) === key);
  if (exact.length === 1) return exact[0];
  const byPrefix = buyers.filter((b) => compact(b.full_name).startsWith(key));
  return byPrefix.length === 1 ? byPrefix[0] : null;
}

// ── Plan ────────────────────────────────────────────────────────────────

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const money = (n: number) => n.toFixed(2);

/** Frases de las notas que salen del Excel (mismo texto que la carga del 21-sep). */
function noteSentences(row: ImportRow): string[] {
  const out: string[] = [];
  if (row.realDate)
    out.push(`Fecha real de fin (Excel): ${isoDay(row.realDate)}.`);
  if (row.admin) out.push(`Adm. de contrato: ${row.admin}.`);
  if (row.term) out.push(`Plazo: ${row.term.toLowerCase()}.`);
  if (row.documentRef) out.push(`Documento (SharePoint): ${row.documentRef}.`);
  return out;
}

export function planContractImport(input: {
  rows: ImportRow[];
  existing: ExistingContract[];
  suppliers: SupplierIndexEntry[];
  buyers?: BuyerIndexEntry[];
  options: PlanOptions;
}): ContractImportPlan {
  const { rows, existing, options } = input;
  const plan: ContractImportPlan = {
    create: [],
    update: [],
    unchanged: [],
    missing: [],
    skipped: [],
    warnings: [],
    errors: [],
    report: {
      newSuppliers: [],
      amountWithoutCurrency: [],
      noEndDate: [],
      statusContradictions: [],
      unmatchedBuyers: [],
    },
  };
  const index = [...input.suppliers];
  const buyers = input.buyers ?? [];
  const byNumber = new Map(existing.map((c) => [c.contract_number, c]));
  const seen = new Set<string>();
  const newSuppliers = new Map<
    string,
    ContractImportReport['newSuppliers'][number]
  >();

  /** Proveedor de la fila: id existente o alta manual (en el plan). */
  const resolveSupplier = (row: ImportRow, where: string, ref: string) => {
    const raw = row.supplierName ?? '';
    const match = matchSupplier(raw, index);
    if (!match.entry && match.ambiguous.length > 0) {
      plan.errors.push(
        `${where}: proveedor "${row.supplierName}" AMBIGUO entre: ${match.ambiguous.join(' / ')}`,
      );
      return null;
    }
    if (match.entry) {
      const isNew = match.entry.id.startsWith('nuevo:');
      if (isNew) {
        // otra fila (o variante) del mismo proveedor nuevo
        const entry = newSuppliers.get(match.entry.legal_name);
        if (entry) {
          entry.rows.push(ref);
          if (!entry.variants.includes(raw)) entry.variants.push(raw);
        }
      }
      return {
        supplier_id: isNew ? undefined : match.entry.id,
        new_supplier_name: isNew ? match.entry.legal_name : undefined,
        name: match.entry.legal_name,
        isNew,
      };
    }
    // alta manual: queda en el índice para las filas siguientes del mismo proveedor
    index.push({
      id: `nuevo:${raw}`,
      legal_name: raw,
      key: compact(raw),
      norm: supplierNormKey(raw),
    });
    newSuppliers.set(raw, { name: raw, variants: [raw], rows: [ref] });
    return {
      supplier_id: undefined,
      new_supplier_name: raw,
      name: raw,
      isNew: true,
    };
  };

  const amountFields = (row: ImportRow, where: string, ref: string) => {
    const currency = row.currency ?? options.defaultCurrency ?? null;
    if ((row.amount !== null || row.consumed !== null) && !currency) {
      plan.warnings.push(
        `${where}: trae monto/consumido sin moneda; no se importan (usa --moneda=MXN si todo es en pesos)`,
      );
      plan.report.amountWithoutCurrency.push(
        `${ref}: ${money(row.amount ?? row.consumed ?? 0)}`,
      );
      return { amount: null, consumed: null, currency: null };
    }
    return { amount: row.amount, consumed: row.consumed, currency };
  };

  const resolveBuyer = (row: ImportRow, ref: string) => {
    if (!row.buyer) return null;
    const buyer = matchBuyer(row.buyer, buyers);
    if (!buyer) plan.report.unmatchedBuyers.push({ ref, name: row.buyer });
    return buyer;
  };

  for (const row of rows) {
    const where = `Fila ${row.rowNumber} (${row.number || 'sin número'})`;
    const ref = row.number || `fila ${row.rowNumber}`;
    if (!row.number) {
      plan.errors.push(`${where}: falta el número de contrato`);
      continue;
    }
    if (seen.has(row.number)) {
      plan.errors.push(
        `${where}: el contrato ${row.number} viene repetido en el archivo; se toma la primera fila`,
      );
      continue;
    }
    seen.add(row.number);
    const current = byNumber.get(row.number);

    // I6: lo que Diana tiene que revisar (altas y existentes por igual)
    if (!row.endDate) plan.report.noEndDate.push(ref);
    if (row.excelStatus && row.endDate) {
      const byDate = contractStatusFor(row.endDate, options.today);
      if (byDate !== row.excelStatus) {
        plan.report.statusContradictions.push({
          ref,
          excel: row.excelStatus,
          byDate,
          end: isoDay(row.endDate),
        });
      }
    }

    if (!current) {
      if (!row.supplierName || !row.service) {
        plan.errors.push(`${where}: faltan proveedor o descripción`);
        continue;
      }
      const supplier = resolveSupplier(row, where, ref);
      if (!supplier) continue;
      const amounts = amountFields(row, where, ref);
      const buyer = resolveBuyer(row, ref);
      const notes = [
        options.importLabel ?? 'Importado del Excel de contratos.',
        ...noteSentences(row),
      ].join(' ');
      const createStatus = contractStatusFor(
        row.endDate,
        options.today,
        row.excelStatus,
      );
      plan.create.push({
        row,
        supplierNote: supplier.isNew
          ? 'ALTA manual (no estaba en el catálogo)'
          : `match: ${supplier.name}`,
        data: {
          contract_number: row.number,
          service_description: row.service,
          supplier_id: supplier.supplier_id,
          new_supplier_name: supplier.new_supplier_name,
          start_date: row.startDate,
          end_date: row.endDate,
          // por fecha de fin; sin ella, el del Excel o vigente
          status: createStatus,
          // J2: el que entra ya vencido es histórico (sin avisos)
          vencido_historico: createStatus === 'vencido',
          document_type: row.documentType ?? 'contrato',
          ...(row.carpeta ? { carpeta: row.carpeta } : {}),
          ...(row.documentLabel ? { document_label: row.documentLabel } : {}),
          ...(row.userArea ? { user_area: row.userArea } : {}),
          ...(buyer ? { buyer_profile_id: buyer.id } : {}),
          ...(row.responsible
            ? { responsible_user_name: row.responsible }
            : {}),
          ...(row.responsibleEmail
            ? { responsible_user_email: row.responsibleEmail }
            : {}),
          total_amount: amounts.amount,
          consumed_amount: amounts.consumed,
          // sin monto no hay moneda (nunca el MXN por default de la columna)
          currency:
            amounts.amount !== null || amounts.consumed !== null
              ? amounts.currency
              : null,
          ...(row.link ? { external_link: row.link } : {}),
          ...(row.tomo ? { tomo: row.tomo } : {}),
          notes,
        },
      });
      continue;
    }

    if (!options.update) {
      plan.skipped.push(row.number);
      continue;
    }

    // ── Existente: solo lo que el archivo trae y es distinto ──
    const changes: FieldChange[] = [];
    const data: ContractData = {};
    const setText = (
      field: ContractField & keyof ContractData,
      from: string | null,
      to: string | null,
    ) => {
      if (to === null || to === (from ?? '')) return;
      changes.push({ field, from, to });
      (data as Record<string, unknown>)[field] = to;
    };
    setText('service_description', current.service_description, row.service);
    setText(
      'responsible_user_name',
      current.responsible_user_name,
      row.responsible,
    );
    setText(
      'responsible_user_email',
      current.responsible_user_email,
      row.responsibleEmail,
    );
    setText('external_link', current.external_link, row.link);
    setText('tomo', current.tomo, row.tomo);
    setText('carpeta', current.carpeta, row.carpeta);
    setText('document_label', current.document_label, row.documentLabel);
    setText('user_area', current.user_area, row.userArea);
    const buyer = resolveBuyer(row, ref);
    if (buyer && buyer.id !== current.buyer_profile_id) {
      changes.push({
        field: 'buyer_profile_id',
        from: current.buyer_profile_id,
        to: buyer.full_name,
      });
      data.buyer_profile_id = buyer.id;
    }
    if (row.documentType && row.documentType !== current.document_type) {
      changes.push({
        field: 'document_type',
        from: current.document_type,
        to: row.documentType,
      });
      data.document_type = row.documentType;
    }
    if (row.supplierName) {
      const supplier = resolveSupplier(row, where, ref);
      if (!supplier) continue;
      if (supplier.isNew || supplier.supplier_id !== current.supplier_id) {
        changes.push({
          field: 'supplier',
          from: current.supplier_name,
          to: supplier.isNew ? `${supplier.name} (alta manual)` : supplier.name,
        });
        data.supplier_id = supplier.supplier_id;
        data.new_supplier_name = supplier.new_supplier_name;
      }
    }
    for (const [field, value, from] of [
      ['start_date', row.startDate, current.start_date],
      ['end_date', row.endDate, current.end_date],
    ] as const) {
      if (value && (from === null || isoDay(value) !== isoDay(from))) {
        changes.push({
          field,
          from: from === null ? null : isoDay(from),
          to: isoDay(value),
        });
        data[field] = value;
      }
    }
    // El estatus se recalcula con la fecha de fin (renovado/cancelado no se
    // tocan); sin fecha de fin, el del Excel si lo trae
    if (['vigente', 'vencido'].includes(current.status)) {
      const end = data.end_date ?? current.end_date;
      const status = end
        ? contractStatusFor(end, options.today)
        : (row.excelStatus ?? current.status);
      if ((data.end_date || !end) && status !== current.status) {
        changes.push({ field: 'status', from: current.status, to: status });
        data.status = status;
        // J2: el histórico solo cuenta mientras esté vencido
        if (status !== 'vencido' && current.vencido_historico) {
          data.vencido_historico = false;
        }
      }
    }
    const amounts = amountFields(row, where, ref);
    const amountChange = (
      field: 'total_amount' | 'consumed_amount',
      value: number | null,
      from: number | null,
    ) => {
      if (value === null || (from !== null && money(value) === money(from)))
        return;
      changes.push({
        field,
        from: from === null ? null : money(from),
        to: money(value),
      });
      data[field] = value;
    };
    amountChange('total_amount', amounts.amount, current.total_amount);
    amountChange('consumed_amount', amounts.consumed, current.consumed_amount);
    // La moneda solo cambia con un monto del archivo (nunca sola)
    if (
      amounts.currency &&
      (amounts.amount !== null || amounts.consumed !== null) &&
      amounts.currency !== current.currency
    ) {
      changes.push({
        field: 'currency',
        from: current.currency,
        to: amounts.currency,
      });
      data.currency = amounts.currency;
    }
    // Notas: nunca se reescriben; lo nuevo del Excel se agrega al final
    const missingSentences = noteSentences(row).filter(
      (s) => !(current.notes ?? '').includes(s),
    );
    if (missingSentences.length > 0) {
      const added = `Actualización del Excel (${isoDay(options.today)}): ${missingSentences.join(' ')}`;
      changes.push({
        field: 'notes',
        from: null,
        to: `+ ${missingSentences.join(' ')}`,
      });
      data.notes = current.notes ? `${current.notes}\n${added}` : added;
    }

    if (changes.length === 0) plan.unchanged.push(row.number);
    else plan.update.push({ row, id: current.id, changes, data });
  }

  if (options.update) {
    for (const c of existing) {
      if (seen.has(c.contract_number)) continue;
      plan.missing.push({
        id: c.id,
        contract_number: c.contract_number,
        supplier_name: c.supplier_name,
        end_date: c.end_date,
        fromPlatform: c.created_by !== null,
      });
    }
  }
  plan.report.newSuppliers = [...newSuppliers.values()];
  return plan;
}
