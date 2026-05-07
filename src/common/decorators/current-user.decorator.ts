import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface UserRoleAssignment {
  module: string;
  role: string;
}

export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  /** Rol primario (legado, mantiene retrocompatibilidad). */
  role: string;
  /** Lista de roles efectivos del usuario (de profiles.role + user_roles activos, deduplicada). */
  roles: string[];
  /** Asignaciones detalladas (módulo + rol) desde user_roles. Vacío si la migración aún no se aplicó. */
  role_assignments: UserRoleAssignment[];
  department_id: string | null;
  is_active: boolean;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext): AuthUser | unknown => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthUser;
    return data ? user?.[data] : user;
  },
);
