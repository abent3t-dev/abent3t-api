/**
 * Estatus de OC de Maximo (G7, reunión con Ingrid 2026-09-28; L3,
 * significados confirmados por el cliente el 2026-10-07).
 *
 * WAPPR = en espera de aprobación; APPRn / APPRnREV = autorización del
 * nivel n (APPRnREV, de una revisión); APPR = aprobada. WAPPR, APPRn y
 * APPRnREV (cualquier n) siguen EN APROBACIÓN: falta el siguiente nivel o la
 * aprobación final. Etiquetas con las palabras del cliente (en la OC, en
 * femenino: Cancelada, Cerrada, Revisada); el código siempre acompaña a la
 * etiqueta. Misma tabla en el front (`types/purchases.ts`).
 *
 * K7 (2026-10-05): las PR tienen su propio mapa (`maximoPrStatusLabel`).
 */

const LEVEL_STATUS = /^APPR(\d+)$/;
const LEVEL_REVISION_STATUS = /^APPR(\d+)REV$/;

/**
 * L3 (tabla del cliente, 2026-10-07): titular de cada nivel de autorización
 * de Maximo (APPRn / APPRnREV). Es el TITULAR del nivel, no necesariamente
 * quien aprobó: quién aprobó sale del usuario del historial y su nombre, del
 * alias de Compras. No es el flujo interno de requisiciones de ABENT
 * (`APPROVAL_LEVEL_NAMES` del front). Misma tabla en el front.
 */
export const MAXIMO_APPROVAL_LEVELS: Readonly<Record<number, string>> = {
  1: 'David Alejandro Rodríguez Ojeda',
  2: 'Miguel Ángel Ortiz García',
  3: 'Gilberto Maltos Vázquez',
  4: 'Uriel Lases García',
  5: 'Alejandro Escandón',
};

/** Último nivel de la tabla del cliente (hoy, 5); después sigue APPR. */
export const MAXIMO_LAST_APPROVAL_LEVEL = Math.max(
  ...Object.keys(MAXIMO_APPROVAL_LEVELS).map(Number),
);

/** Titular del nivel n; null si el nivel no está en la tabla del cliente. */
export function maximoLevelHolder(level: number | null): string | null {
  return level === null ? null : (MAXIMO_APPROVAL_LEVELS[level] ?? null);
}

export const MAXIMO_STATUS_LABELS: Record<string, string> = {
  APPR: 'Aprobada',
  WAPPR: 'En espera de aprobación',
  PNDREV: 'Revisión pendiente',
  REVISD: 'Revisada',
  INPRG: 'En progreso',
  HOLD: 'En suspenso',
  COMP: 'Completada',
  CLOSE: 'Cerrada',
  CAN: 'Cancelada',
  CANCEL: 'Cancelada',
  DRAFT: 'Borrador',
};

/** Nivel ya aprobado de APPRn / APPRnREV; null para cualquier otro estatus. */
export function maximoApprovedLevel(status: string | null): number | null {
  if (!status) return null;
  const match = LEVEL_STATUS.exec(status) ?? LEVEL_REVISION_STATUS.exec(status);
  return match ? Number(match[1]) : null;
}

/** WAPPR, APPRn y APPRnREV: la OC sigue en aprobación. */
export function isMaximoInApproval(status: string | null): boolean {
  return status === 'WAPPR' || maximoApprovedLevel(status) !== null;
}

/** L3: APPRn y APPRnREV = "Autorización n" (tabla del cliente). */
export function maximoStatusLabel(status: string | null): string {
  if (!status) return '';
  const known = MAXIMO_STATUS_LABELS[status];
  if (known) return known;
  const level = maximoApprovedLevel(status);
  return level === null ? status : `Autorización ${level}`;
}

/** Etiqueta con el código, para exports: "Autorización 1 (APPR1)". */
export function maximoStatusWithCode(status: string | null): string {
  if (!status) return '';
  const label = maximoStatusLabel(status);
  return label === status ? status : `${label} (${status})`;
}

/**
 * K7 (2026-10-05): estatus DE LA PR (raíz de AB_CONTRATOS), aparte del de la
 * OC: en una PR, APPR es la llegada a Compras y WAPPR que todavía no llega.
 * Misma tabla en el front (`MAXIMO_PR_STATUS_OPTIONS`). Un estatus
 * desconocido sale tal cual.
 */
export const MAXIMO_PR_STATUS_LABELS: Record<string, string> = {
  WAPPR: 'En aprobación',
  APPR: 'Aprobada: llegó a Compras',
  CLOSE: 'Cerrada',
  CAN: 'Cancelada',
};

export function maximoPrStatusLabel(status: string | null): string {
  if (!status) return '';
  return MAXIMO_PR_STATUS_LABELS[status] ?? status;
}

/** Estatus de la PR con el código, para exports: "En aprobación (WAPPR)". */
export function maximoPrStatusWithCode(status: string | null): string {
  if (!status) return '';
  const label = maximoPrStatusLabel(status);
  return label === status ? status : `${label} (${status})`;
}
