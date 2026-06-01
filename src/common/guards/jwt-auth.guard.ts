import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthService } from '../../auth/services/jwt-auth.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthUser } from '../decorators/current-user.decorator';

/**
 * JwtAuthGuard — reemplaza al viejo SupabaseAuthGuard (Fase 2).
 *
 * Lee el access token de DOS fuentes (en este orden):
 *   1. Cookie `access_token` (default — set por /auth/login-local y /auth/callback).
 *   2. Header `Authorization: Bearer <jwt>` (compat con clientes legacy o tools).
 *
 * Valida la firma + expiración + tipo del JWT (debe ser 'access'), y luego
 * carga `request.user` con el mismo shape que el viejo guard (AuthUser:
 * id, email, full_name, department_id, role, roles[], role_assignments[]).
 *
 * El contrato `request.user` NO cambia respecto al viejo guard. Por eso
 * `RolesGuard`, `DepartmentGuard`, `@Roles(...)` siguen funcionando intactos.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtAuth: JwtAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Token de autenticación requerido');
    }

    const payload = await this.jwtAuth.verifyAccess(token);
    request.user = (await this.jwtAuth.buildRequestUser(payload.sub)) as AuthUser;
    return true;
  }

  private extractToken(request: {
    cookies?: Record<string, string>;
    headers: Record<string, string | string[] | undefined>;
  }): string | null {
    // 1. Cookie
    const cookieToken = request.cookies?.access_token;
    if (cookieToken) return cookieToken;

    // 2. Authorization header
    const authHeader = request.headers.authorization;
    const headerStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (headerStr?.startsWith('Bearer ')) {
      return headerStr.substring(7);
    }

    return null;
  }
}
