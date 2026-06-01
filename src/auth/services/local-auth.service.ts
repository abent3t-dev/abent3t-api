import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthEventsService } from './auth-events.service';

const BCRYPT_ROUNDS = 10;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;

export interface AuthenticatedProfile {
  id: string;
  email: string;
  full_name: string | null;
  department_id: string | null;
  must_change_password: boolean;
}

/**
 * LocalAuthService — login email+password contra `local_credentials`.
 *
 * Solo está activo cuando `ALLOW_LOCAL_LOGIN=true` (default en dev).
 * En PROD con Entra ID configurado, este flag se pone en false y este
 * service no se usa.
 *
 * Reglas:
 *   * bcrypt rounds = 10 (estándar)
 *   * Tras 5 intentos fallidos consecutivos, locked_until = now + 15min
 *   * Login exitoso resetea failed_attempts y locked_until
 *   * Cuenta inactiva (profile.is_active=false) NO puede loguearse aunque
 *     la contraseña sea correcta
 *   * Cada intento (success o fail) se registra en auth_events
 */
@Injectable()
export class LocalAuthService {
  private readonly logger = new Logger(LocalAuthService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authEvents: AuthEventsService,
  ) {
    this.enabled = (process.env.ALLOW_LOCAL_LOGIN ?? '').toLowerCase() === 'true';
    if (this.enabled) {
      this.logger.warn(
        '⚠️ ALLOW_LOCAL_LOGIN=true — el endpoint /auth/login-local está habilitado. ' +
          'No usar en producción una vez que Entra ID esté configurado.',
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Autentica al usuario con email + password.
   * Lanza `UnauthorizedException` si las credenciales son inválidas.
   * Lanza `ForbiddenException` si la cuenta está desactivada o bloqueada.
   */
  async authenticate(
    email: string,
    password: string,
    context: { ip_address?: string | null; user_agent?: string | null } = {},
  ): Promise<AuthenticatedProfile> {
    if (!this.enabled) {
      throw new ForbiddenException(
        'El login con email/password está deshabilitado en este entorno.',
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException('Email requerido');
    }

    const profile = await this.prisma.profiles.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      select: {
        id: true,
        email: true,
        full_name: true,
        department_id: true,
        is_active: true,
        local_credentials: {
          select: {
            password_hash: true,
            failed_attempts: true,
            locked_until: true,
            must_change_password: true,
            is_active: true,
          },
        },
      },
    });

    // Usuario no existe
    if (!profile) {
      await this.authEvents.record({
        event_type: 'login_failed_user',
        email: normalizedEmail,
        success: false,
        reason: 'profile_not_found',
        ip_address: context.ip_address,
        user_agent: context.user_agent,
      });
      // Mensaje genérico para no filtrar existencia de cuentas
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Perfil inactivo
    if (!profile.is_active) {
      await this.authEvents.record({
        event_type: 'login_failed_inactive',
        email: normalizedEmail,
        profile_id: profile.id,
        success: false,
        reason: 'profile_inactive',
        ip_address: context.ip_address,
        user_agent: context.user_agent,
      });
      throw new ForbiddenException('Usuario desactivado');
    }

    const cred = profile.local_credentials;

    // No tiene credencial local seteada
    if (!cred || !cred.is_active) {
      await this.authEvents.record({
        event_type: 'login_failed_user',
        email: normalizedEmail,
        profile_id: profile.id,
        success: false,
        reason: 'no_local_credentials',
        ip_address: context.ip_address,
        user_agent: context.user_agent,
      });
      throw new UnauthorizedException(
        'Esta cuenta no tiene contraseña local configurada. Contacta al administrador.',
      );
    }

    // Locked out
    if (cred.locked_until && cred.locked_until > new Date()) {
      await this.authEvents.record({
        event_type: 'login_failed_locked',
        email: normalizedEmail,
        profile_id: profile.id,
        success: false,
        reason: `locked_until_${cred.locked_until.toISOString()}`,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
      });
      throw new ForbiddenException(
        'Cuenta temporalmente bloqueada por demasiados intentos fallidos. Intenta más tarde.',
      );
    }

    // Verificar password
    const ok = await bcrypt.compare(password, cred.password_hash);
    if (!ok) {
      // Incrementar failed_attempts. Si llega al límite, bloquear.
      const nextAttempts = (cred.failed_attempts ?? 0) + 1;
      const shouldLock = nextAttempts >= MAX_FAILED_ATTEMPTS;
      await this.prisma.local_credentials.update({
        where: { profile_id: profile.id },
        data: {
          failed_attempts: nextAttempts,
          locked_until: shouldLock
            ? new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000)
            : null,
        },
      });
      await this.authEvents.record({
        event_type: 'login_failed_password',
        email: normalizedEmail,
        profile_id: profile.id,
        success: false,
        reason: `wrong_password_attempt_${nextAttempts}${shouldLock ? '_locked' : ''}`,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
      });
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // OK — resetear contador, marcar last_login, bajar pending_first_login
    await Promise.all([
      this.prisma.local_credentials.update({
        where: { profile_id: profile.id },
        data: {
          failed_attempts: 0,
          locked_until: null,
          last_login_at: new Date(),
        },
      }),
      // Una vez que el usuario se autentica con éxito por primera vez, ya
      // no está "pending" (cumple el modelo K-7 del MIGRATION_AUDIT).
      this.prisma.profiles.update({
        where: { id: profile.id },
        data: { pending_first_login: false },
      }),
    ]);

    await this.authEvents.record({
      event_type: 'login_success',
      email: normalizedEmail,
      profile_id: profile.id,
      success: true,
      reason: 'local_login',
      ip_address: context.ip_address,
      user_agent: context.user_agent,
    });

    return {
      id: profile.id,
      email: profile.email,
      full_name: profile.full_name,
      department_id: profile.department_id,
      must_change_password: cred.must_change_password ?? false,
    };
  }

  /**
   * Setea (o cambia) la contraseña local de un perfil. Usado por admin_rh /
   * super_admin para alta de usuarios y resets de contraseña. Si el caller
   * pasa `mustChangePassword=true`, el usuario será forzado a cambiarla en
   * su próximo login (UI responsabilidad).
   */
  async setPassword(
    profileId: string,
    plainPassword: string,
    options: { mustChangePassword?: boolean; performedBy?: string } = {},
  ): Promise<void> {
    if (plainPassword.length < 6) {
      throw new BadRequestException(
        'La contraseña debe tener al menos 6 caracteres',
      );
    }

    const profile = await this.prisma.profiles.findUnique({
      where: { id: profileId },
      select: { id: true, email: true, is_active: true },
    });
    if (!profile) throw new NotFoundException('Perfil no encontrado');
    if (!profile.is_active) {
      throw new BadRequestException(
        'No se puede asignar contraseña a un perfil desactivado',
      );
    }

    const password_hash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

    await this.prisma.local_credentials.upsert({
      where: { profile_id: profileId },
      create: {
        profile_id: profileId,
        password_hash,
        must_change_password: options.mustChangePassword ?? false,
        is_active: true,
      },
      update: {
        password_hash,
        password_set_at: new Date(),
        must_change_password: options.mustChangePassword ?? false,
        is_active: true,
        failed_attempts: 0,
        locked_until: null,
      },
    });

    await this.authEvents.record({
      event_type: 'password_set',
      email: profile.email,
      profile_id: profile.id,
      success: true,
      reason: options.performedBy
        ? `set_by_${options.performedBy}`
        : 'self_set',
    });
  }

  /**
   * Cambio de password por el propio usuario (requiere password actual).
   * Diferente de `setPassword` (que lo usa admin).
   */
  async changeOwnPassword(
    profileId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (newPassword.length < 6) {
      throw new BadRequestException(
        'La nueva contraseña debe tener al menos 6 caracteres',
      );
    }

    const cred = await this.prisma.local_credentials.findUnique({
      where: { profile_id: profileId },
      select: { password_hash: true, is_active: true },
    });
    if (!cred || !cred.is_active) {
      throw new BadRequestException(
        'No tienes credencial local configurada',
      );
    }

    const ok = await bcrypt.compare(currentPassword, cred.password_hash);
    if (!ok) {
      throw new UnauthorizedException('La contraseña actual es incorrecta');
    }

    const password_hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await this.prisma.local_credentials.update({
      where: { profile_id: profileId },
      data: {
        password_hash,
        password_set_at: new Date(),
        must_change_password: false,
        failed_attempts: 0,
        locked_until: null,
      },
    });

    const profile = await this.prisma.profiles.findUnique({
      where: { id: profileId },
      select: { email: true },
    });
    await this.authEvents.record({
      event_type: 'password_changed',
      email: profile?.email ?? null,
      profile_id: profileId,
      success: true,
      reason: 'self_change',
    });
  }
}
