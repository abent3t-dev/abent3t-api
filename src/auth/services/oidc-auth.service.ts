import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import * as crypto from 'crypto';
import { AuthEventsService } from './auth-events.service';
import { PrismaService } from '../../prisma/prisma.service';

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/**
 * OIDCAuthService — flujo Authorization Code de Microsoft Entra ID (OIDC).
 *
 * Cliente confidencial "Web" (usa client_secret; el canje del code se hace
 * server-to-server). El propósito es LOGIN/SSO: se valida y consume el
 * **id_token** (aud = Client ID), NO el access_token. Tras validar la
 * identidad, el backend emite su propio JWT (ver JwtAuthService), igual que
 * el login local.
 *
 * Se activa cuando las variables `AZURE_AD_*` están presentes. Mientras estén
 * vacías, `isConfigured()` es false y los endpoints `/auth/login` y
 * `/auth/callback` operan en modo "no configurado".
 *
 * Modelo de pre-registro (K-7): Entra autentica, pero el usuario DEBE existir
 * previamente en `profiles` (alta por un admin). Si el correo autenticado no
 * tiene perfil, se rechaza el acceso.
 */
@Injectable()
export class OIDCAuthService {
  private readonly logger = new Logger(OIDCAuthService.name);
  private discovery?: OidcDiscovery;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly authEvents: AuthEventsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Indica si el flujo OIDC está configurado para usarse en runtime. */
  isConfigured(): boolean {
    return Boolean(
      process.env.AZURE_AD_TENANT_ID &&
        process.env.AZURE_AD_CLIENT_ID &&
        process.env.AZURE_AD_CLIENT_SECRET &&
        process.env.AZURE_AD_REDIRECT_URI,
    );
  }

  /** Lanza 503 si el flujo OIDC no está configurado. */
  private assertConfigured(): void {
    if (!this.isConfigured()) {
      this.logger.warn(
        'Intento de iniciar flujo OIDC sin AZURE_AD_* configurado',
      );
      throw new ServiceUnavailableException(
        'El login con Microsoft no está configurado en este entorno. ' +
          'Usa email + password mientras tanto.',
      );
    }
  }

  private get tenantId(): string {
    return process.env.AZURE_AD_TENANT_ID as string;
  }
  private get clientId(): string {
    return process.env.AZURE_AD_CLIENT_ID as string;
  }
  private get clientSecret(): string {
    return process.env.AZURE_AD_CLIENT_SECRET as string;
  }
  private get redirectUri(): string {
    return process.env.AZURE_AD_REDIRECT_URI as string;
  }

  /**
   * Descubre los endpoints y el JWKS de Entra ID vía el documento
   * `.well-known/openid-configuration`. Se cachea en memoria (el JWKS remoto
   * de `jose` maneja su propio refresco de llaves).
   */
  private async ensureDiscovery(): Promise<OidcDiscovery> {
    if (this.discovery && this.jwks) return this.discovery;
    const url = `https://login.microsoftonline.com/${this.tenantId}/v2.0/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new ServiceUnavailableException(
        'No se pudo obtener la configuración OIDC de Entra ID',
      );
    }
    const doc = (await res.json()) as OidcDiscovery;
    this.discovery = doc;
    this.jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
    return doc;
  }

  /** Genera `state` (anti-CSRF) y `nonce` (anti-replay) para un nuevo flujo. */
  createStateNonce(): { state: string; nonce: string } {
    return {
      state: crypto.randomBytes(16).toString('hex'),
      nonce: crypto.randomBytes(16).toString('hex'),
    };
  }

  /**
   * Paso 1 — URL de autorización de Entra (Authorization Code).
   * El `state` y `nonce` los persiste el controlador en una cookie corta y
   * los revalida en el callback.
   */
  async buildAuthorizationUrl(state: string, nonce: string): Promise<string> {
    this.assertConfigured();
    const doc = await this.ensureDiscovery();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    return url.toString();
  }

  /**
   * Paso 2 — procesa el callback del IdP:
   *   1) canjea el `code` por tokens en `/token` (server-to-server).
   *   2) valida el `id_token` (firma JWKS + issuer + audience + exp + nonce).
   *   3) extrae el `email`, valida el dominio permitido.
   *   4) busca el perfil PRE-REGISTRADO; si no existe, rechaza.
   *   5) marca `pending_first_login=false`, registra `auth_event`.
   * Devuelve `{ profileId, email }` para que el controlador emita el JWT propio.
   */
  async handleCallback(
    code: string,
    expectedNonce: string,
    context: { ip_address?: string | null; user_agent?: string | null } = {},
  ): Promise<{ profileId: string; email: string }> {
    this.assertConfigured();
    const doc = await this.ensureDiscovery();

    if (!code) {
      throw new UnauthorizedException('Falta el código de autorización');
    }

    // 1) Canje del code por tokens.
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: 'openid profile email',
    });
    const tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      this.logger.error(`Fallo canje de code (${tokenRes.status}): ${detail}`);
      throw new UnauthorizedException(
        'No se pudo completar el inicio de sesión con Microsoft',
      );
    }
    const tokenJson = (await tokenRes.json()) as { id_token?: string };
    if (!tokenJson.id_token) {
      throw new UnauthorizedException('Entra ID no devolvió id_token');
    }

    // 2) Validar id_token: firma (JWKS) + issuer + audience + expiración.
    let claims: JWTPayload;
    try {
      const verified = await jwtVerify(tokenJson.id_token, this.jwks!, {
        issuer: doc.issuer,
        audience: this.clientId,
        clockTolerance: '30s',
      });
      claims = verified.payload;
    } catch (e) {
      this.logger.error(`id_token inválido: ${(e as Error).message}`);
      throw new UnauthorizedException('El token de Microsoft no es válido');
    }

    // 2b) nonce (anti-replay).
    if (expectedNonce && claims.nonce !== expectedNonce) {
      throw new UnauthorizedException('nonce no coincide (posible replay)');
    }

    // 3) Email (con respaldos) + validación de dominio.
    const email = String(
      (claims.email as string) ||
        (claims.preferred_username as string) ||
        (claims.upn as string) ||
        '',
    )
      .trim()
      .toLowerCase();

    if (!email) {
      await this.authEvents.record({
        event_type: 'login_failed_user',
        success: false,
        reason: 'no_email_claim',
        ip_address: context.ip_address,
        user_agent: context.user_agent,
      });
      throw new UnauthorizedException('El token no contiene un correo');
    }

    const allowedDomain = process.env.ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase();
    if (allowedDomain && !email.endsWith(`@${allowedDomain}`)) {
      await this.authEvents.record({
        event_type: 'login_failed_user',
        email,
        success: false,
        reason: 'domain_not_allowed',
        ip_address: context.ip_address,
        user_agent: context.user_agent,
      });
      throw new ForbiddenException('Dominio de correo no permitido');
    }

    // 4) Perfil PRE-REGISTRADO (modelo K-7): debe existir.
    const profile = await this.prisma.profiles.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, email: true, is_active: true },
    });
    if (!profile) {
      await this.authEvents.record({
        event_type: 'login_failed_user',
        email,
        success: false,
        reason: 'profile_not_found_oidc',
        ip_address: context.ip_address,
        user_agent: context.user_agent,
      });
      throw new ForbiddenException(
        'Tu cuenta de Microsoft es válida pero no estás registrado en la plataforma. ' +
          'Contacta al administrador.',
      );
    }
    if (!profile.is_active) {
      await this.authEvents.record({
        event_type: 'login_failed_inactive',
        email,
        profile_id: profile.id,
        success: false,
        reason: 'profile_inactive',
        ip_address: context.ip_address,
        user_agent: context.user_agent,
      });
      throw new ForbiddenException('Usuario desactivado');
    }

    // 5) Marcar activación (K-7) y registrar el éxito.
    await this.prisma.profiles.update({
      where: { id: profile.id },
      data: { pending_first_login: false },
    });
    await this.authEvents.record({
      event_type: 'login_success',
      email,
      profile_id: profile.id,
      success: true,
      reason: 'oidc_login',
      ip_address: context.ip_address,
      user_agent: context.user_agent,
    });

    return { profileId: profile.id, email: profile.email };
  }
}
