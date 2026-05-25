import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthUser } from '../decorators/current-user.decorator';

/**
 * Department Guard — restringe a jefe_area / director a su propio
 * departamento.
 *
 * Aplica a endpoints que reciben department_id (route param, query o body).
 * Si el caller es jefe_area o director y el department_id pedido NO coincide
 * con el suyo, lanza 403.
 *
 * - super_admin y admin_rh bypassean este guard
 * - colaborador no se filtra por departamento (su acceso se valida por user_id
 *   en otra parte), así que el guard lo deja pasar
 *
 * Si NO se envía department_id, el guard deja pasar — es responsabilidad del
 * service hacer scoping automático al departamento del usuario.
 *
 * Soporta multi-rol leyendo `user.roles[]` (no solo `user.role`).
 */
@Injectable()
export class DepartmentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthUser | undefined;

    if (!user) return false;

    const effectiveRoles = new Set<string>([
      ...(user.roles ?? []),
      ...(user.role ? [user.role] : []),
    ]);

    // Bypass para roles que ven todo
    if (effectiveRoles.has('super_admin') || effectiveRoles.has('admin_rh')) {
      return true;
    }

    const isManager =
      effectiveRoles.has('jefe_area') || effectiveRoles.has('director');

    if (!isManager) {
      // Roles que no son managers (colaborador, executive, etc.) pasan: el
      // scoping de su acceso se hace por user_id, no por departamento.
      return true;
    }

    const requestedDeptId =
      request.params?.departmentId ||
      request.query?.department_id ||
      request.body?.department_id;

    if (!requestedDeptId) {
      // Sin filtro explícito: el service debe scopear automáticamente al
      // departamento del usuario.
      return true;
    }

    if (requestedDeptId !== user.department_id) {
      throw new ForbiddenException(
        'Solo puedes acceder a datos de tu propia área',
      );
    }

    return true;
  }
}
