import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { LoggerLike } from '../common';
import { SAP_CONFIG, SAP_LOGGER, SAP_LOGIN_FN, SAP_NOW_FN } from './sap.config';
import type { SapConfig } from './sap.config';
import { SapNotConfiguredError } from './sap.errors';
import { postSapLogin } from './sap-transport';
import type { SapLoginResult } from './sap-transport';

/**
 * Gestor de sesión del Service Layer (decisión T2): el `POST /Login` vive
 * AISLADO aquí — el cliente genérico de Int-1 sigue siendo GET-only y no se
 * toca. El path del login es una constante del transporte (no hay parámetro),
 * así que este gestor no puede usarse para escribir en SAP.
 *
 * Cachea el cookie jar (B1SESSION + ROUTEID) y re-loguea cuando la sesión
 * está por expirar (margen de seguridad) o cuando el cliente lo invalida
 * tras un 401. Logins concurrentes se colapsan en una sola petición.
 */

/** Se renueva este margen ANTES de que SAP expire la sesión (30 min típico). */
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60_000;
/** Piso de vida útil por si SAP informara un timeout absurdo (< margen). */
const MIN_SESSION_LIFETIME_MS = 60_000;

export type SapLoginFn = typeof postSapLogin;

@Injectable()
export class SapSessionManager {
  #cookieHeader: string | null = null;
  #expiresAtMs = 0;
  #pendingLogin: Promise<string> | null = null;

  private readonly logger: LoggerLike;
  private readonly loginFn: SapLoginFn;
  private readonly now: () => number;

  constructor(
    @Inject(SAP_CONFIG) private readonly config: SapConfig,
    @Optional() @Inject(SAP_LOGGER) logger?: LoggerLike,
    // Inyección para tests (no usar en producción): con @Optional+token Nest
    // resuelve undefined; sin los decoradores el contenedor no arranca
    // (intenta resolver el tipo Function como provider).
    @Optional() @Inject(SAP_LOGIN_FN) loginFn?: SapLoginFn,
    @Optional() @Inject(SAP_NOW_FN) now?: () => number,
  ) {
    this.logger = logger ?? new Logger('Integration:sap');
    this.loginFn = loginFn ?? postSapLogin;
    this.now = now ?? Date.now;
  }

  /** Faltantes de configuración (para `SapNotConfiguredError`). */
  missingConfig(): string[] {
    const missing: string[] = [];
    if (!this.config.baseUrl) missing.push('SL_BASE_URL');
    if (!this.config.companyDb) missing.push('SL_COMPANY_DB');
    if (!this.config.user) missing.push('SL_USER');
    if (!this.config.password) missing.push('SL_PASSWORD');
    return missing;
  }

  /**
   * Header `Cookie` con sesión vigente; hace login si no hay o expiró.
   * El valor NUNCA debe loguearse (Int-1 ya redacta `Cookie` por heurística).
   */
  async getCookieHeader(): Promise<string> {
    const missing = this.missingConfig();
    if (missing.length > 0) throw new SapNotConfiguredError(missing);

    if (this.#cookieHeader !== null && this.now() < this.#expiresAtMs) {
      return this.#cookieHeader;
    }
    if (this.#pendingLogin) return this.#pendingLogin;

    this.#pendingLogin = this.login().finally(() => {
      this.#pendingLogin = null;
    });
    return this.#pendingLogin;
  }

  /**
   * Descarta la sesión cacheada (p. ej. tras un 401 en un GET). Si se pasa
   * la cookie que falló, solo invalida cuando sigue siendo la vigente: dos
   * corridas concurrentes con la misma cookie vieja no se tumban entre sí
   * la sesión recién renovada.
   */
  invalidate(failedCookie?: string): void {
    if (failedCookie !== undefined && this.#cookieHeader !== failedCookie) {
      return; // otra llamada ya renovó la sesión
    }
    this.#cookieHeader = null;
    this.#expiresAtMs = 0;
  }

  private async login(): Promise<string> {
    const result: SapLoginResult = await this.loginFn({
      // missingConfig() ya garantizó que no son null
      baseUrl: this.config.baseUrl as string,
      companyDb: this.config.companyDb as string,
      userName: this.config.user as string,
      password: this.config.password as string,
      tls: { rejectUnauthorized: this.config.rejectUnauthorized },
      timeoutMs: this.config.timeoutMs,
    });
    const lifetimeMs = Math.max(
      MIN_SESSION_LIFETIME_MS,
      result.sessionTimeoutMinutes * 60_000 - EXPIRY_SAFETY_MARGIN_MS,
    );
    this.#cookieHeader = result.cookieHeader;
    this.#expiresAtMs = this.now() + lifetimeMs;
    this.logger.log(
      `Sesión SAP abierta (vigencia ~${Math.round(lifetimeMs / 60_000)} min)`,
    );
    return result.cookieHeader;
  }
}
