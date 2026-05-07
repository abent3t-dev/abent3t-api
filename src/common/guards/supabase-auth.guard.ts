import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseService } from '../../supabase/supabase.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthUser } from '../decorators/current-user.decorator';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token de autenticación requerido');
    }

    const token = authHeader.substring(7);

    // Validate JWT with Supabase
    const {
      data: { user },
      error,
    } = await this.supabase.db.auth.getUser(token);

    if (error || !user) {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    // Get profile with role and department
    const { data: profile, error: profileError } = await this.supabase.db
      .from('profiles')
      .select('id, email, full_name, role, department_id, is_active')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      throw new UnauthorizedException('Perfil de usuario no encontrado');
    }

    if (!profile.is_active) {
      throw new UnauthorizedException('Usuario desactivado');
    }

    // Cargar roles adicionales por módulo (tabla user_roles).
    // Si la tabla no existe todavía o falla, degradamos al rol primario.
    let assignments: { module: string; role: string }[] = [];
    try {
      const { data: rolesData } = await this.supabase.db
        .from('user_roles')
        .select('module, role')
        .eq('profile_id', user.id)
        .eq('is_active', true);
      assignments = rolesData ?? [];
    } catch {
      assignments = [];
    }

    // Lista deduplicada de roles efectivos: rol primario + roles asignados.
    const allRoles = new Set<string>();
    if (profile.role) allRoles.add(profile.role);
    for (const a of assignments) allRoles.add(a.role);

    // Attach user to request
    request.user = {
      ...profile,
      roles: Array.from(allRoles),
      role_assignments: assignments,
    } as AuthUser;

    return true;
  }
}
