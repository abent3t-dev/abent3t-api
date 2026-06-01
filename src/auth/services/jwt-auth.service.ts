import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { getDisplayRole } from '../../common/services/user-roles.helper';

export interface JwtPayload {
  /** profile.id (uuid) */
  sub: string;
  email: string;
  /** Tipo de token para diferenciar access de refresh. */
  type: 'access' | 'refresh';
  /** Origen del login. */
  origin: 'oidc' | 'local';
  /** ID de sesión (jti) — útil para revocar refresh tokens en el futuro. */
  jti: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // segundos
}

/**
 * JwtAuthService — emite y valida los JWT propios de la plataforma.
 *
 * Estos JWT reemplazan al token de Supabase Auth. Cualquier endpoint del
 * backend valida `request.user` cargado por el `JwtAuthGuard` global, que a
 * su vez usa este service para verificar la firma y el shape del payload.
 *
 * El access token vive en cookie HttpOnly con TTL corto (8h por default).
 * El refresh token también va en cookie HttpOnly con TTL largo (7d por
 * default) y se usa para emitir nuevos access tokens sin re-autenticar.
 */
@Injectable()
export class JwtAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Emite par (access, refresh) para un perfil. Genera un nuevo `jti` por
   * cada par para futura revocación selectiva (si se desea).
   */
  async issueTokens(
    profileId: string,
    email: string,
    origin: 'oidc' | 'local',
  ): Promise<IssuedTokens> {
    const jti = crypto.randomUUID();
    const accessExpiresIn = process.env.JWT_EXPIRES_IN || '8h';
    const refreshExpiresIn = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';

    const accessPayload: JwtPayload = {
      sub: profileId,
      email,
      type: 'access',
      origin,
      jti,
    };
    const refreshPayload: JwtPayload = {
      sub: profileId,
      email,
      type: 'refresh',
      origin,
      jti,
    };

    const accessToken = await this.jwt.signAsync(accessPayload, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expiresIn: accessExpiresIn as any,
    });
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expiresIn: refreshExpiresIn as any,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.parseExpiresInSeconds(accessExpiresIn),
    };
  }

  /**
   * Verifica un access token. Devuelve el payload o lanza
   * UnauthorizedException con mensaje útil.
   */
  async verifyAccess(token: string): Promise<JwtPayload> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Token de tipo incorrecto');
    }
    return payload;
  }

  /**
   * Verifica un refresh token. Mismo comportamiento que verifyAccess pero
   * exige `type === 'refresh'`.
   */
  async verifyRefresh(token: string): Promise<JwtPayload> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException(
        'Refresh token de tipo incorrecto',
      );
    }
    return payload;
  }

  /**
   * Dado un `profile.id`, arma el shape `request.user` que el resto del
   * sistema espera. Se usa en `JwtAuthGuard` y al refrescar tokens.
   */
  async buildRequestUser(profileId: string) {
    const profile = await this.prisma.profiles.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        email: true,
        full_name: true,
        department_id: true,
        is_active: true,
      },
    });
    if (!profile) {
      throw new UnauthorizedException('Perfil de usuario no encontrado');
    }
    if (!profile.is_active) {
      throw new UnauthorizedException('Usuario desactivado');
    }

    const assignments = await this.prisma.user_roles.findMany({
      where: { profile_id: profileId, is_active: true },
      select: { module: true, role: true },
    });

    const roles = Array.from(new Set(assignments.map((a) => a.role)));
    const role = getDisplayRole(roles) ?? '';

    return {
      ...profile,
      role,
      roles,
      role_assignments: assignments,
    };
  }

  /** Parsea strings tipo '8h', '7d', '15m' a segundos. */
  private parseExpiresInSeconds(expr: string): number {
    const m = /^(\d+)\s*([smhd])$/i.exec(expr.trim());
    if (!m) return 60 * 60 * 8; // fallback 8h
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const mult: Record<string, number> = {
      s: 1,
      m: 60,
      h: 3600,
      d: 86400,
    };
    return n * (mult[unit] ?? 3600);
  }
}
