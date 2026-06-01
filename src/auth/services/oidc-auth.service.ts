import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AuthEventsService } from './auth-events.service';

/**
 * OIDCAuthService — esqueleto para el flujo Microsoft Entra ID (OAuth 2.0 /
 * OIDC). Está completo a nivel de interfaz pero **no operativo** mientras
 * las variables `AZURE_AD_*` estén vacías (config actual de dev, ya que TI
 * de Abent 3T entrega esas credenciales hasta producción — ver
 * `documentation/MIGRATION.md` §3 y el memoria `auth-dev-email-fallback.md`).
 *
 * Cuando lleguen las credenciales:
 *   1. Setear `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`,
 *      `AZURE_AD_REDIRECT_URI` en `.env`.
 *   2. Implementar `buildAuthorizationUrl()` y `handleCallback()` con la
 *      librería que se decida (`openid-client` recomendado, o
 *      `@azure/msal-node`).
 *   3. Quitar el `ServiceUnavailableException` de `assertConfigured()`.
 *
 * Mientras: los endpoints `/auth/login` y `/auth/callback` responden 503
 * con un mensaje claro. El frontend muestra solo el path email+password
 * cuando `ALLOW_LOCAL_LOGIN=true`.
 */
@Injectable()
export class OIDCAuthService {
  private readonly logger = new Logger(OIDCAuthService.name);

  constructor(private readonly authEvents: AuthEventsService) {}

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

  /**
   * Genera la URL de autorización (paso 1 del flujo Authorization Code).
   *
   * Stub: lanza 503 hasta que llegue la implementación real.
   */
  buildAuthorizationUrl(_state: string): string {
    this.assertConfigured();
    // TODO Fase 2 (cuando llegue Azure):
    //   const url = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
    //   url.searchParams.set('client_id', clientId);
    //   url.searchParams.set('response_type', 'code');
    //   url.searchParams.set('redirect_uri', redirectUri);
    //   url.searchParams.set('response_mode', 'query');
    //   url.searchParams.set('scope', 'openid profile email');
    //   url.searchParams.set('state', state);
    //   return url.toString();
    throw new ServiceUnavailableException('OIDC no implementado todavía');
  }

  /**
   * Procesa el callback del IdP: intercambia code por id_token, valida
   * firma+audience+issuer+expiración+dominio, busca/crea el perfil, emite
   * JWT propio.
   *
   * Stub: lanza 503.
   */
  async handleCallback(
    _code: string,
    _state: string,
    _context: { ip_address?: string | null; user_agent?: string | null } = {},
  ): Promise<{
    profileId: string;
    email: string;
  }> {
    this.assertConfigured();
    // TODO Fase 2 (cuando llegue Azure):
    //   1) POST a `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
    //      con grant_type=authorization_code, code, client_id, client_secret, redirect_uri.
    //   2) Validar id_token con JWKS de Entra (issuer + audience + signature).
    //   3) Extraer email del id_token y validar dominio @ALLOWED_EMAIL_DOMAIN.
    //   4) Buscar profile por email (case-insensitive). Si no existe:
    //      registrar auth_event 'login_failed_user' + lanzar Forbidden.
    //      (Modelo K-7: admin debe pre-registrar al usuario antes.)
    //   5) Marcar pending_first_login=false. Guardar `oid` de Entra si se decide.
    //   6) Registrar auth_event 'login_success' (origin='oidc').
    //   7) Devolver { profileId, email } al caller.
    throw new ServiceUnavailableException('OIDC no implementado todavía');
  }
}
