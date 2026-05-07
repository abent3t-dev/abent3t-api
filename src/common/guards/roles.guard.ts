import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthUser } from '../decorators/current-user.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No roles required = allow any authenticated user
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthUser;

    if (!user) {
      throw new ForbiddenException(
        'No tienes permisos para realizar esta acción',
      );
    }

    // Conjunto de roles efectivos del usuario: combina el rol primario
    // (profiles.role) con los asignados por módulo (user_roles).
    const userRoles = new Set<string>([
      ...(user.roles ?? []),
      ...(user.role ? [user.role] : []),
    ]);

    // super_admin bypassa todo
    if (userRoles.has('super_admin')) {
      return true;
    }

    const hasRequired = requiredRoles.some((r) => userRoles.has(r));
    if (!hasRequired) {
      throw new ForbiddenException(
        'No tienes permisos para realizar esta acción',
      );
    }

    return true;
  }
}
