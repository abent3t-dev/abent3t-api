import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  ForbiddenException,
  Redirect,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LocalAuthService } from './services/local-auth.service';
import { JwtAuthService } from './services/jwt-auth.service';
import { OIDCAuthService } from './services/oidc-auth.service';
import { AuthEventsService } from './services/auth-events.service';
import { LoginLocalDto } from './dto/login-local.dto';
import { SetLocalCredentialsDto } from './dto/set-local-credentials.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { Public } from '../common/decorators/public.decorator';

// Configuración de cookies HttpOnly. SameSite=Lax permite el redirect OAuth.
// `Secure` solo en producción (cookie sin Secure no llega por HTTPS).
function cookieOptions(maxAgeSeconds: number, isRefresh = false) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: maxAgeSeconds * 1000,
    // El refresh token solo se envía a /api/auth (más restrictivo).
    path: isRefresh ? '/api/auth' : '/',
  };
}

function extractContext(req: Request) {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null;
  const userAgent = (req.headers['user-agent'] as string) || null;
  return { ip_address: ip, user_agent: userAgent };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly local: LocalAuthService,
    private readonly jwtAuth: JwtAuthService,
    private readonly oidc: OIDCAuthService,
    private readonly authEvents: AuthEventsService,
  ) {}

  // ========================================================================
  // ENDPOINTS DE AUTENTICACIÓN
  // ========================================================================

  /**
   * Configuración pública para que el frontend sepa qué paths de login
   * mostrar (Microsoft, email/password, o ambos).
   */
  @Public()
  @Get('config')
  getAuthConfig() {
    return {
      oidc_enabled: this.oidc.isConfigured(),
      local_login_enabled: this.local.isEnabled(),
      allowed_email_domain: process.env.ALLOWED_EMAIL_DOMAIN || null,
    };
  }

  /**
   * Login con email + password (modo dev hasta que Entra ID esté listo).
   * Emite JWT propio (access + refresh) en cookies HttpOnly.
   */
  @Public()
  @Post('login-local')
  @HttpCode(HttpStatus.OK)
  async loginLocal(
    @Body() dto: LoginLocalDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = extractContext(req);
    const profile = await this.local.authenticate(dto.email, dto.password, ctx);
    const tokens = await this.jwtAuth.issueTokens(
      profile.id,
      profile.email,
      'local',
    );

    res.cookie('access_token', tokens.accessToken, cookieOptions(tokens.expiresIn));
    res.cookie(
      'refresh_token',
      tokens.refreshToken,
      cookieOptions(7 * 24 * 3600, true),
    );

    return {
      user: await this.service.getProfile(profile.id),
      must_change_password: profile.must_change_password,
    };
  }

  /**
   * Refresca el access token usando el refresh token de la cookie.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = (req as Request & { cookies?: Record<string, string> })
      .cookies?.refresh_token;
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token no encontrado');
    }

    const payload = await this.jwtAuth.verifyRefresh(refreshToken);
    // Reconstruir y rotar
    const tokens = await this.jwtAuth.issueTokens(
      payload.sub,
      payload.email,
      payload.origin,
    );

    res.cookie('access_token', tokens.accessToken, cookieOptions(tokens.expiresIn));
    res.cookie(
      'refresh_token',
      tokens.refreshToken,
      cookieOptions(7 * 24 * 3600, true),
    );

    await this.authEvents.record({
      event_type: 'refresh',
      email: payload.email,
      profile_id: payload.sub,
      success: true,
      reason: 'token_rotation',
      ip_address: extractContext(req).ip_address,
      user_agent: extractContext(req).user_agent,
    });

    return { ok: true };
  }

  /** Cierra la sesión (limpia cookies y registra el evento). */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const accessToken = (req as Request & { cookies?: Record<string, string> })
      .cookies?.access_token;

    let payload: { sub: string; email: string } | null = null;
    if (accessToken) {
      try {
        payload = await this.jwtAuth.verifyAccess(accessToken);
      } catch {
        // ignorar — logout siempre debe limpiar las cookies aunque el token esté inválido
      }
    }

    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('refresh_token', { path: '/api/auth' });

    if (payload) {
      await this.authEvents.record({
        event_type: 'logout',
        email: payload.email,
        profile_id: payload.sub,
        success: true,
        ip_address: extractContext(req).ip_address,
        user_agent: extractContext(req).user_agent,
      });
    }

    return { ok: true };
  }

  /**
   * OIDC — inicia el flujo de Microsoft Entra ID. Stub hasta que TI entregue
   * las credenciales Azure. Devuelve 503 con un mensaje útil.
   */
  @Public()
  @Get('login')
  @Redirect()
  loginOIDC() {
    if (!this.oidc.isConfigured()) {
      // Si OIDC no está configurado pero local sí, redirige al login local
      if (this.local.isEnabled()) {
        const frontendUrl =
          process.env.FRONTEND_URL?.split(',')[0]?.trim() ||
          'http://localhost:3000';
        return { url: `${frontendUrl}/login`, statusCode: 302 };
      }
      throw new ForbiddenException(
        'El login con Microsoft no está configurado y el login local está deshabilitado',
      );
    }

    // TODO Fase 2 (cuando llegue Azure): generar state aleatorio, persistirlo,
    // y redirigir a `this.oidc.buildAuthorizationUrl(state)`.
    throw new ForbiddenException('OIDC no implementado todavía');
  }

  /**
   * OIDC callback — recibe `code` y `state` de Entra ID. Stub hasta Azure.
   */
  @Public()
  @Get('callback')
  oidcCallback(@Query('code') _code: string, @Query('state') _state: string) {
    if (!this.oidc.isConfigured()) {
      throw new ForbiddenException(
        'OIDC no configurado. Usa el login local mientras tanto.',
      );
    }
    // TODO Fase 2 (cuando llegue Azure):
    //   1) const { profileId, email } = await this.oidc.handleCallback(code, state, ctx);
    //   2) const tokens = await this.jwtAuth.issueTokens(profileId, email, 'oidc');
    //   3) setear cookies, redirigir al frontend a /home.
    throw new ForbiddenException('OIDC no implementado todavía');
  }

  /** Get current user's profile (requiere JwtAuthGuard). */
  @Get('me')
  getMe(@CurrentUser() user: AuthUser) {
    return this.service.getProfile(user.id);
  }

  /** Cambiar la propia contraseña (login local). */
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changeMyPassword(
    @CurrentUser() user: AuthUser,
    @Body() body: { current_password: string; new_password: string },
  ) {
    await this.local.changeOwnPassword(
      user.id,
      body.current_password,
      body.new_password,
    );
    return { ok: true };
  }

  // ========================================================================
  // GESTIÓN DE USUARIOS / ROLES (admin)
  // ========================================================================

  /** Get team members (jefe_area/director - returns users from their department) */
  @Get('my-team')
  @Roles('jefe_area', 'director', 'admin_rh', 'super_admin')
  getMyTeam(@CurrentUser() user: AuthUser) {
    if (!user.department_id) {
      return [];
    }
    return this.service.getMyTeam(user.department_id, user.id);
  }

  /** Buscar usuario por email (super_admin y admin_rh). */
  @Get('lookup-email')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin_rh')
  lookupEmail(@Query('email') email: string) {
    return this.service.lookupByEmail(email || '');
  }

  /** List all users (Super Admin and admin_rh) */
  @Get('users')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin_rh')
  listUsers(
    @Query('role') role?: string,
    @Query('department_id') departmentId?: string,
    @Query('is_active') isActive?: string,
  ) {
    return this.service.listUsers({
      role,
      department_id: departmentId,
      is_active: isActive !== undefined ? isActive === 'true' : undefined,
    });
  }

  /** Assign role to user (Super Admin only) */
  @Put('users/:id/role')
  @UseGuards(RolesGuard)
  @Roles('super_admin')
  updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('role') role: string,
    @CurrentUser() current: AuthUser,
  ) {
    return this.service.updateRole(id, role, current.id);
  }

  /** Assign department to user (Super Admin only) */
  @Put('users/:id/department')
  @UseGuards(RolesGuard)
  @Roles('super_admin')
  assignDepartment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('department_id') departmentId: string,
  ) {
    return this.service.assignDepartment(id, departmentId);
  }

  /** Deactivate user - soft delete (Super Admin only) */
  @Put('users/:id/deactivate')
  @UseGuards(RolesGuard)
  @Roles('super_admin')
  deactivateUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deactivateUser(id);
  }

  /** Reactivate user (Super Admin only) */
  @Put('users/:id/reactivate')
  @UseGuards(RolesGuard)
  @Roles('super_admin')
  reactivateUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.reactivateUser(id);
  }

  /** Create new user (Super Admin only). Modelo K-7: pre-registro. */
  @Post('users')
  @UseGuards(RolesGuard)
  @Roles('super_admin')
  createUser(
    @Body() body: {
      email: string;
      password: string;
      full_name: string;
      position?: string;
      role?: string;
      department_id?: string;
    },
    @CurrentUser() current: AuthUser,
  ) {
    return this.service.createUser(body, current.id);
  }

  /**
   * Setear/cambiar la contraseña local de un usuario (super_admin / admin_rh).
   * Si se pasa `must_change_password=true`, el usuario es forzado a cambiarla
   * en su próximo login. Útil para resets desde el panel admin.
   */
  @Post('users/:id/local-credentials')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin_rh')
  async setLocalCredentials(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetLocalCredentialsDto,
    @CurrentUser() current: AuthUser,
  ) {
    await this.local.setPassword(id, dto.password, {
      mustChangePassword: dto.must_change_password,
      performedBy: current.id,
    });
    return { ok: true };
  }

  /** Listar asignaciones de rol por módulo de un usuario. */
  @Get('users/:id/roles')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin_rh')
  listUserRoles(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.listUserRoles(id);
  }

  /** Asignar un rol a un usuario en un módulo. */
  @Post('users/:id/roles')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin_rh')
  assignUserRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { module: string; role: string },
    @CurrentUser() current: AuthUser,
  ) {
    const isSuper = current.roles?.includes('super_admin');
    const allowedModules = isSuper ? undefined : ['capacitacion'];
    const allowedRoles = isSuper ? undefined : ['colaborador', 'jefe_area'];
    return this.service.assignUserRole(
      id,
      body.module,
      body.role,
      current.id,
      allowedModules,
      allowedRoles,
    );
  }

  /** Revocar una asignación de rol. */
  @Put('users/:id/roles/:roleId/revoke')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin_rh')
  revokeUserRole(
    @Param('id', ParseUUIDPipe) _id: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @CurrentUser() current: AuthUser,
  ) {
    const isSuper = current.roles?.includes('super_admin');
    const allowedModules = isSuper ? undefined : ['capacitacion'];
    const allowedRoles = isSuper ? undefined : ['colaborador', 'jefe_area'];
    return this.service.revokeUserRole(
      roleId,
      current.id,
      allowedModules,
      allowedRoles,
    );
  }
}
