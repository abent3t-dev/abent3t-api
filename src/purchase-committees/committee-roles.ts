// Roles de compras del comité (§Roles y Permisos + §17). Un solo lugar para
// el controller (guards) y el service (quién puede ocupar un nivel).

export const PURCHASE_TEAM = [
  'lider_procura',
  'coordinador_compras',
  'comprador',
];

export const APPROVERS = [
  'aprobador_nivel_1',
  'aprobador_nivel_2',
  'aprobador_nivel_3',
  'director_general',
];

// APPROVERS_COMITE (§17): lider_procura es el nivel 1 de la cadena
export const APPROVERS_COMITE = ['lider_procura', ...APPROVERS];

export const PURCHASE_ADMINS = ['super_admin', 'lider_procura'];

/**
 * H3: quien ocupa un nivel por PERSONA necesita uno de estos roles, o el
 * guard de aprobar/rechazar (APPROVERS_COMITE; super_admin lo salta) no lo
 * deja firmar.
 */
export const COMMITTEE_SIGNER_ROLES = ['super_admin', ...APPROVERS_COMITE];
