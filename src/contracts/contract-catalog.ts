/**
 * I6 (go-live 2026-09-30) — Catálogos del control de contratos de Compras
 * (Control_de_contratos_A3T.xlsx, "Hoja2") y el número de cada documento.
 *
 * Una carpeta (A3T-0003) agrupa el contrato con su carta de intención,
 * enmiendas y convenios. `contract_number` es UNIQUE, así que el número se
 * arma con la carpeta y el sufijo del tipo: Contrato = A3T-0003 (el segundo
 * contrato de la carpeta, A3T-0010-2), Carta de intención = -CI, Enmienda N
 * = -E{N}, Convenio modificatorio = -CM, Terminación = -TER, Acta de
 * recepción = -AR, Cesión de derechos = -CD y Otro = -OT. Lo usan el
 * importador y el alta en la plataforma, para que los dos numeren igual.
 *
 * Funciones puras (sin BD).
 */

export type ContractDocumentType =
  | 'contrato'
  | 'addenda'
  | 'convenio'
  | 'carta_compromiso'
  | 'otro';

export type ContractStatus = 'vigente' | 'vencido' | 'renovado' | 'cancelado';

/** Las 11 áreas usuarias del catálogo de Compras (el responsable es el área). */
export const CONTRACT_USER_AREAS = [
  'Operaciones',
  'Legal',
  'Dirección',
  'Recursos Humanos',
  'Comercial',
  'Medición',
  'Finanzas',
  'Servicios Generales',
  'IT',
  'Seguridad patrimonial',
  'GEV',
] as const;

export type ContractUserArea = (typeof CONTRACT_USER_AREAS)[number];

export const CONTRACT_DOC_KINDS = [
  'contrato',
  'carta_intencion',
  'enmienda',
  'convenio_modificatorio',
  'terminacion',
  'acta_recepcion',
  'cesion_derechos',
  'otro',
] as const;

export type ContractDocKind = (typeof CONTRACT_DOC_KINDS)[number];

const KIND_INFO: Record<
  ContractDocKind,
  { label: string; suffix: string; type: ContractDocumentType }
> = {
  contrato: { label: 'Contrato', suffix: '', type: 'contrato' },
  carta_intencion: {
    label: 'Carta de intención',
    suffix: 'CI',
    type: 'carta_compromiso',
  },
  enmienda: { label: 'Enmienda', suffix: 'E', type: 'addenda' },
  convenio_modificatorio: {
    label: 'Convenio modificatorio',
    suffix: 'CM',
    type: 'convenio',
  },
  terminacion: { label: 'Terminación', suffix: 'TER', type: 'otro' },
  acta_recepcion: { label: 'Acta de recepción', suffix: 'AR', type: 'otro' },
  cesion_derechos: { label: 'Cesión de derechos', suffix: 'CD', type: 'otro' },
  otro: { label: 'Otro', suffix: 'OT', type: 'otro' },
};

/** Orden de los documentos dentro de la carpeta (el contrato primero). */
const KIND_ORDER: Record<ContractDocKind, number> = {
  contrato: 0,
  carta_intencion: 1,
  enmienda: 2,
  convenio_modificatorio: 3,
  cesion_derechos: 4,
  terminacion: 5,
  acta_recepcion: 6,
  otro: 7,
};

/** Sin acentos, sin puntuación, sin espacios, mayúsculas. */
export function compactText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

/**
 * Tipo del archivo ("Carta de Intencion", "Enmienda 3", "Acta recepción"…).
 * null = vacío.
 */
export function parseDocKind(
  value: unknown,
): { kind: ContractDocKind; n: number | null } | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const key = compactText(value);
  const digits = /(\d+)$/.exec(key);
  const n = digits ? Number(digits[1]) : null;
  if (key.startsWith('CONTRATO')) return { kind: 'contrato', n: null };
  if (key.startsWith('CARTA')) return { kind: 'carta_intencion', n: null };
  if (
    ['ENMIENDA', 'ADDENDA', 'ADENDA', 'ADDENDUM'].some((k) => key.startsWith(k))
  ) {
    return { kind: 'enmienda', n };
  }
  if (key.startsWith('CONVENIO')) {
    return { kind: 'convenio_modificatorio', n: null };
  }
  if (key.startsWith('TERMINACION')) return { kind: 'terminacion', n: null };
  if (key.startsWith('ACTA')) return { kind: 'acta_recepcion', n: null };
  if (key.startsWith('CESION')) return { kind: 'cesion_derechos', n: null };
  return { kind: 'otro', n: null };
}

/** "Enmienda 3", "Carta de intención"… (lo que se guarda en document_label). */
export function docKindLabel(kind: ContractDocKind, n: number | null): string {
  const { label } = KIND_INFO[kind];
  return kind === 'enmienda' && n !== null ? `${label} ${n}` : label;
}

/** Tipo genérico del documento (enum `contract_document_type`). */
export function docKindType(kind: ContractDocKind): ContractDocumentType {
  return KIND_INFO[kind].type;
}

/** Tipo de un documento ya guardado: por su etiqueta y, si no, por el enum. */
export function docKindOf(contract: {
  document_label: string | null;
  document_type: ContractDocumentType;
}): ContractDocKind {
  const parsed = parseDocKind(contract.document_label);
  if (parsed) return parsed.kind;
  switch (contract.document_type) {
    case 'contrato':
      return 'contrato';
    case 'addenda':
      return 'enmienda';
    case 'convenio':
      return 'convenio_modificatorio';
    case 'carta_compromiso':
      return 'carta_intencion';
    default:
      return 'otro';
  }
}

/** Nombre del tipo para tablas y filtros ("Enmienda", sin número). */
export function docKindName(kind: ContractDocKind): string {
  return KIND_INFO[kind].label;
}

/** Orden dentro de la carpeta: contrato, CI, enmiendas (por número), CM… */
export function docKindRank(kind: ContractDocKind, n: number | null): number {
  return KIND_ORDER[kind] * 1000 + (n ?? 0);
}

/** "a3t-3", "A3T 0003" o "A3T-0003" → "A3T-0003"; null si no es carpeta. */
export function normalizeCarpeta(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^A3T\s*-?\s*(\d{1,4})$/i.exec(String(value).trim());
  return match ? `A3T-${match[1].padStart(4, '0')}` : null;
}

/** Número sin desempate: A3T-0003, A3T-0003-CI, A3T-0003-E2… */
export function baseContractNumber(
  carpeta: string,
  kind: ContractDocKind,
  n: number | null,
): string {
  if (kind === 'contrato') return carpeta;
  const { suffix } = KIND_INFO[kind];
  return `${carpeta}-${suffix}${kind === 'enmienda' && n !== null ? n : ''}`;
}

/** Número del documento; si ya existe, el siguiente lleva -2, -3… */
export function contractNumberFor(
  carpeta: string,
  kind: ContractDocKind,
  n: number | null,
  isTaken: (number: string) => boolean,
): string {
  const base = baseContractNumber(carpeta, kind, n);
  if (!isTaken(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/** Área del catálogo (sin importar acentos ni mayúsculas); null = vacía. */
export function normalizeUserArea(value: unknown): {
  area: string | null;
  known: boolean;
} {
  if (typeof value !== 'string' || value.trim() === '') {
    return { area: null, known: true };
  }
  const key = compactText(value);
  const known = CONTRACT_USER_AREAS.find((a) => compactText(a) === key);
  return known
    ? { area: known, known: true }
    : { area: value.trim().replace(/\s+/g, ' '), known: false };
}

/** Estatus capturado a mano en el Excel ("VIGENTE", "vencido"…). */
export function normalizeExcelStatus(
  value: unknown,
): 'vigente' | 'vencido' | null {
  if (typeof value !== 'string') return null;
  const key = compactText(value);
  if (key === 'VIGENTE') return 'vigente';
  if (key === 'VENCIDO') return 'vencido';
  return null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Estatus por fecha de fin, como siempre. Sin fecha de fin (permanentes,
 * "por servicio"): el que se capture (o vigente).
 */
export function contractStatusFor(
  end: Date | null,
  today: Date,
  withoutEnd: ContractStatus | null = null,
): ContractStatus {
  if (!end) return withoutEnd ?? 'vigente';
  return isoDay(end) < isoDay(today) ? 'vencido' : 'vigente';
}
