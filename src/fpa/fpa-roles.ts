// FP&A (0021; roles aprobados por Alex el 2026-10-19). El rol da la entrada
// al módulo; qué hace cada quien en cada área lo dice fpa_assignments y lo
// valida el service. Un solo lugar para el controller (guards) y el service.

/** Entran al módulo y leen (cada área solo lo suyo; ver FPA_SEE_ALL). */
export const FPA_ROLES = [
  'super_admin',
  'fpa_area',
  'fpa_planeacion',
  'fpa_cfo',
];

/**
 * Agregan, editan y dan de baja líneas: fpa_area donde tiene la captura
 * (titular o suplente) y planeación en cualquier área (decisión 3 de A2:
 * edita e importa, pero no envía). El CFO solo lee.
 */
export const FPA_EDITORS = ['super_admin', 'fpa_area', 'fpa_planeacion'];

/** Administran áreas y responsables (después: catálogo y versiones). */
export const FPA_ADMIN = ['super_admin', 'fpa_planeacion'];

/** Ven todas las áreas; fpa_area solo las suyas. */
export const FPA_SEE_ALL = ['super_admin', 'fpa_planeacion', 'fpa_cfo'];

/** Roles del módulo fpa en user_roles (para el directorio de personas). */
export const FPA_MODULE_ROLES = ['fpa_area', 'fpa_planeacion', 'fpa_cfo'];
