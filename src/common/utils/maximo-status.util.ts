/**
 * Estatus de OC de Maximo (G7, reunión con Ingrid 2026-09-28).
 *
 * Inventario del historial POSTATUS en prod (G6): WAPPR = envío a
 * aprobación; APPRn = aprobación del nivel n; APPR = aprobación final;
 * APPRnREV = aprobación de una revisión en el nivel n. WAPPR, APPRn y
 * APPRnREV (cualquier n) siguen EN APROBACIÓN: falta el siguiente nivel o la
 * aprobación final. Etiquetas provisionales hasta que Alfredo confirme los
 * significados; el código siempre acompaña a la etiqueta.
 */

const LEVEL_STATUS = /^APPR(\d+)$/;
const LEVEL_REVISION_STATUS = /^APPR(\d+)REV$/;

export const MAXIMO_STATUS_LABELS: Record<string, string> = {
  APPR: 'Aprobada',
  WAPPR: 'En espera de aprobación',
  PNDREV: 'Pendiente de revisión',
  REVISD: 'Revisada',
  INPRG: 'En proceso',
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

export function maximoStatusLabel(status: string | null): string {
  if (!status) return '';
  const known = MAXIMO_STATUS_LABELS[status];
  if (known) return known;
  const revision = LEVEL_REVISION_STATUS.exec(status);
  if (revision) {
    return `En aprobación · revisión aprobada en nivel ${revision[1]}`;
  }
  const level = LEVEL_STATUS.exec(status);
  if (level) return `En aprobación · nivel ${level[1]} aprobado`;
  return status;
}

/** Etiqueta con el código, para exports: "En aprobación · nivel 1 aprobado (APPR1)". */
export function maximoStatusWithCode(status: string | null): string {
  if (!status) return '';
  const label = maximoStatusLabel(status);
  return label === status ? status : `${label} (${status})`;
}
