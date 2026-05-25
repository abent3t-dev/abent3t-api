import { AuthUser } from '../decorators/current-user.decorator';

/**
 * Devuelve el set efectivo de roles del usuario combinando el rol primario
 * (`profiles.role`, legado) con los asignados por módulo (`user_roles`).
 */
export function getEffectiveRoles(user: AuthUser): Set<string> {
  return new Set<string>([
    ...(user.roles ?? []),
    ...(user.role ? [user.role] : []),
  ]);
}

export function hasAnyRole(user: AuthUser, ...roles: string[]): boolean {
  const eff = getEffectiveRoles(user);
  return roles.some((r) => eff.has(r));
}

export function isAdmin(user: AuthUser): boolean {
  return hasAnyRole(user, 'super_admin', 'admin_rh');
}

export function isManager(user: AuthUser): boolean {
  return hasAnyRole(user, 'jefe_area', 'director');
}
