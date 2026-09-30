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
 * Reglas de siempre: monto sin moneda no se importa (salvo `--moneda=XXX`
 * explícito); el "% disponible" no es un monto; estatus por fecha de fin.
 */

export type ContractDocumentType =
  | 'contrato'
  | 'addenda'
  | 'convenio'
  | 'carta_compromiso'
  | 'otro';

export type ContractStatus = 'vigente' | 'vencido' | 'renovado' | 'cancelado';

/** Una fila del Excel ya interpretada (null = la celda viene vacía). */
export interface ImportRow {
  rowNumber: number;
  number: string;
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
}

export interface ExistingContract {
  id: string;
  contract_number: string;
  tomo: string | null;
  document_type: ContractDocumentType;
  service_description: string;
  supplier_id: string;
  supplier_name: string;
  start_date: Date;
  end_date: Date;
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
}

export interface SupplierIndexEntry {
  id: string;
  legal_name: string;
  key: string;
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
  | 'notes';

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
  start_date?: Date;
  end_date?: Date;
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
}

export interface ContractImportPlan {
  create: Array<{
    row: ImportRow;
    data: ContractData & {
      contract_number: string;
      service_description: string;
      start_date: Date;
      end_date: Date;
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
    end_date: Date;
    fromPlatform: boolean;
  }>;
  /** Existentes en el archivo que no se revisaron (sin `--update`). */
  skipped: string[];
  warnings: string[];
  errors: string[];
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
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

/** Placeholder de RFC para proveedores sin RFC (tax_id UNIQUE). */
export function placeholderTaxId(name: string): string {
  return `SIN-RFC-${compact(name).slice(0, 30)}`.slice(0, 40);
}

/** Encabezados aceptados por campo (el formato del 21-sep va primero). */
const HEADERS: Record<keyof Omit<ImportRow, 'rowNumber'>, string[]> = {
  number: ['Contrato', 'No. contrato', 'Número de contrato', 'Numero'],
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
  documentRef: ['Documento'],
  amount: ['Monto', 'Monto total', 'Importe', 'Valor', 'Valor del contrato'],
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
  tomo: ['Tomo'],
  documentType: ['Tipo', 'Tipo de documento'],
};

/** Fechas del Excel: Date (cellDates), serial numérico o texto. */
export function parseExcelDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    // Serial de Excel: días desde 1899-12-30
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value.trim());
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  return null;
}

/** "$1,234.50" → 1234.5; vacío o texto → null. Un porcentaje NO es monto. */
export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.includes('%')) return null;
  const n = Number(text.replace(/[$\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** MXN / USD / EUR con los nombres que se usan en la oficina. */
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
  if (typeof value !== 'string' || value.trim() === '') return null;
  const key = compact(value);
  if (key.startsWith('CONTRATO')) return 'contrato';
  if (
    ['ADDENDA', 'ADENDA', 'ENMIENDA', 'ADDENDUM'].some((k) => key.startsWith(k))
  ) {
    return 'addenda';
  }
  if (key.startsWith('CONVENIO')) return 'convenio';
  if (key.startsWith('CARTA')) return 'carta_compromiso';
  return 'otro';
}

const isHttpUrl = (value: string) => /^https?:\/\/\S+$/i.test(value);

/** Registros del Excel (sheet_to_json) → filas; celdas vacías = null. */
export function normalizeContractRows(
  records: Array<Record<string, unknown>>,
): {
  rows: ImportRow[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const rows: ImportRow[] = [];
  records.forEach((record, index) => {
    const byKey = new Map(
      Object.entries(record).map(([k, v]) => [compact(k), v]),
    );
    const cell = (field: keyof typeof HEADERS): unknown => {
      for (const header of HEADERS[field]) {
        const value = byKey.get(compact(header));
        if (value !== undefined && value !== null && value !== '') return value;
      }
      return null;
    };
    const text = (field: keyof typeof HEADERS): string | null => {
      const value = cell(field);
      if (typeof value === 'string') return value.trim() || null;
      if (typeof value === 'number') return String(value);
      return null;
    };
    const number = text('number');
    const supplierName = text('supplierName');
    if (!number && !supplierName) return; // fila vacía
    const rowNumber = index + 2; // 1 = encabezados
    let link = text('link');
    if (link && !isHttpUrl(link)) {
      warnings.push(
        `Fila ${rowNumber} (${number ?? 'sin número'}): el link no es una URL http(s); no se importa`,
      );
      link = null;
    }
    const email = text('responsibleEmail');
    rows.push({
      rowNumber,
      number: number ?? '',
      supplierName,
      service: text('service'),
      startDate: parseExcelDate(cell('startDate')),
      endDate: parseExcelDate(cell('endDate')),
      realDate: parseExcelDate(cell('realDate')),
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
      documentType: parseDocumentType(cell('documentType')),
    });
  });
  return { rows, warnings };
}

// ── Proveedores ─────────────────────────────────────────────────────────

/**
 * Proveedor por nombre contra el índice en memoria: exacto compacto y luego
 * prefijo único (≥10 caracteres; los nombres del Excel vienen truncados).
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
  const byPrefix = index.filter(
    (s) =>
      (key.length >= 10 && s.key.startsWith(key)) ||
      (s.key.length >= 10 && key.startsWith(s.key)),
  );
  if (byPrefix.length === 1) return { entry: byPrefix[0], ambiguous: [] };
  return { entry: null, ambiguous: byPrefix.map((s) => s.legal_name) };
}

// ── Plan ────────────────────────────────────────────────────────────────

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const statusFor = (end: Date, today: Date): ContractStatus =>
  isoDay(end) < isoDay(today) ? 'vencido' : 'vigente';

const money = (n: number) => n.toFixed(2);

/** Frases de las notas que salen del Excel (mismo texto que la carga del 21-sep). */
function noteSentences(row: ImportRow): string[] {
  const out: string[] = [];
  if (row.realDate)
    out.push(`Fecha real de fin (Excel): ${isoDay(row.realDate)}.`);
  if (row.admin) out.push(`Adm. de contrato: ${row.admin}.`);
  if (row.documentRef) out.push(`Documento (SharePoint): ${row.documentRef}.`);
  return out;
}

export function planContractImport(input: {
  rows: ImportRow[];
  existing: ExistingContract[];
  suppliers: SupplierIndexEntry[];
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
  };
  const index = [...input.suppliers];
  const byNumber = new Map(existing.map((c) => [c.contract_number, c]));
  const seen = new Set<string>();

  /** Proveedor de la fila: id existente o alta manual (en el plan). */
  const resolveSupplier = (row: ImportRow, where: string) => {
    const match = matchSupplier(row.supplierName ?? '', index);
    if (!match.entry && match.ambiguous.length > 0) {
      plan.errors.push(
        `${where}: proveedor "${row.supplierName}" AMBIGUO entre: ${match.ambiguous.join(' / ')}`,
      );
      return null;
    }
    if (match.entry) {
      return {
        supplier_id: match.entry.id.startsWith('nuevo:')
          ? undefined
          : match.entry.id,
        new_supplier_name: match.entry.id.startsWith('nuevo:')
          ? match.entry.legal_name
          : undefined,
        name: match.entry.legal_name,
        isNew: match.entry.id.startsWith('nuevo:'),
      };
    }
    // alta manual: queda en el índice para las filas siguientes del mismo proveedor
    const name = row.supplierName ?? '';
    index.push({ id: `nuevo:${name}`, legal_name: name, key: compact(name) });
    return {
      supplier_id: undefined,
      new_supplier_name: name,
      name,
      isNew: true,
    };
  };

  const amountFields = (row: ImportRow, where: string) => {
    const currency = row.currency ?? options.defaultCurrency ?? null;
    if ((row.amount !== null || row.consumed !== null) && !currency) {
      plan.warnings.push(
        `${where}: trae monto/consumido sin moneda; no se importan (usa --moneda=MXN si todo es en pesos)`,
      );
      return { amount: null, consumed: null, currency: null };
    }
    return { amount: row.amount, consumed: row.consumed, currency };
  };

  for (const row of rows) {
    const where = `Fila ${row.rowNumber} (${row.number || 'sin número'})`;
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

    if (!current) {
      if (!row.supplierName || !row.service) {
        plan.errors.push(`${where}: faltan proveedor o descripción`);
        continue;
      }
      if (!row.startDate || !row.endDate) {
        plan.errors.push(
          `${where}: vigencia incompleta (Fecha Inicio/Fecha Fin)`,
        );
        continue;
      }
      const supplier = resolveSupplier(row, where);
      if (!supplier) continue;
      const amounts = amountFields(row, where);
      const notes = [
        options.importLabel ?? 'Importado del Excel de contratos.',
        ...noteSentences(row),
      ].join(' ');
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
          status: statusFor(row.endDate, options.today),
          document_type: row.documentType ?? 'contrato',
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
    if (row.documentType && row.documentType !== current.document_type) {
      changes.push({
        field: 'document_type',
        from: current.document_type,
        to: row.documentType,
      });
      data.document_type = row.documentType;
    }
    if (row.supplierName) {
      const supplier = resolveSupplier(row, where);
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
      if (value && isoDay(value) !== isoDay(from)) {
        changes.push({ field, from: isoDay(from), to: isoDay(value) });
        data[field] = value;
      }
    }
    // Con fin nuevo, el estatus se recalcula (renovado/cancelado no se tocan)
    if (data.end_date && ['vigente', 'vencido'].includes(current.status)) {
      const status = statusFor(data.end_date, options.today);
      if (status !== current.status) {
        changes.push({ field: 'status', from: current.status, to: status });
        data.status = status;
      }
    }
    const amounts = amountFields(row, where);
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
  return plan;
}
