/**
 * Jerarquía de errores normalizados para integraciones externas (Maximo, SAP).
 *
 * Fase INT-1. Todos los errores son de LECTURA: el cliente transversal solo
 * emite GET. Ningún error transporta headers, cookies ni credenciales — solo
 * el sistema, la URL ya saneada (sin query params sensibles), el número de
 * intento en el que falló y, cuando aplica, status + cuerpo truncado. El
 * `cause` es una copia DEPURADA del error original (nombre, código y mensaje
 * con URL/secretos reemplazados), nunca el objeto que lanzó `fetch`.
 *
 *   IntegrationError (base)
 *   ├── IntegrationAuthError        401/403 — NO se reintenta
 *   ├── IntegrationRequestError     4xx restantes (incluye 429 tras agotar reintentos)
 *   ├── IntegrationServerError      5xx tras agotar reintentos
 *   ├── IntegrationTimeoutError     timeout tras agotar reintentos
 *   └── IntegrationNetworkError     fallo de red tras agotar reintentos
 */

export interface IntegrationErrorContext {
  /** Identificador del sistema externo (p. ej. 'maximo', 'sap'). */
  system?: string;
  /** URL saneada (sin valores de query params sensibles). */
  url: string;
  /** Intento (1-based) en el que se produjo el fallo definitivo. */
  attempt: number;
  /** Error original ya depurado (sin URL cruda ni valores de headers). */
  cause?: unknown;
}

export class IntegrationError extends Error {
  readonly system?: string;
  readonly url: string;
  readonly attempt: number;

  constructor(message: string, ctx: IntegrationErrorContext) {
    super(message, { cause: ctx.cause });
    this.name = new.target.name;
    this.system = ctx.system;
    this.url = ctx.url;
    this.attempt = ctx.attempt;
  }
}

/** 401/403. Un token vencido o sin permisos no se arregla reintentando. */
export class IntegrationAuthError extends IntegrationError {
  readonly status: number;
  /** Cuerpo de la respuesta truncado (Maximo devuelve el código BMXAA… aquí). */
  readonly body: string;

  constructor(
    ctx: IntegrationErrorContext & { status: number; body?: string },
  ) {
    super(
      `Autenticación rechazada por ${ctx.system ?? 'sistema externo'} (HTTP ${ctx.status}) en ${ctx.url}`,
      ctx,
    );
    this.status = ctx.status;
    this.body = ctx.body ?? '';
  }
}

/**
 * Respuesta recibida pero inutilizable y sin reintento: 4xx distinto de
 * 401/403, 3xx (no se siguen redirecciones), 2xx con cuerpo que no es JSON,
 * y 429 únicamente si se agotan los intentos.
 */
export class IntegrationRequestError extends IntegrationError {
  readonly status: number;
  /** Cuerpo de la respuesta truncado (diagnóstico). */
  readonly body: string;

  constructor(
    ctx: IntegrationErrorContext & {
      status: number;
      body: string;
      reason?: string;
    },
  ) {
    super(
      `${ctx.reason ?? 'Petición rechazada'} por ${ctx.system ?? 'sistema externo'} (HTTP ${ctx.status}) en ${ctx.url}`,
      ctx,
    );
    this.status = ctx.status;
    this.body = ctx.body;
  }
}

/** 5xx después de agotar los reintentos. */
export class IntegrationServerError extends IntegrationError {
  readonly status: number;
  readonly body: string;

  constructor(ctx: IntegrationErrorContext & { status: number; body: string }) {
    super(
      `Error del servidor de ${ctx.system ?? 'sistema externo'} (HTTP ${ctx.status}) en ${ctx.url} tras ${ctx.attempt} intento(s)`,
      ctx,
    );
    this.status = ctx.status;
    this.body = ctx.body;
  }
}

/** Timeout (cabeceras o cuerpo) después de agotar los reintentos. */
export class IntegrationTimeoutError extends IntegrationError {
  readonly timeoutMs: number;

  constructor(ctx: IntegrationErrorContext & { timeoutMs: number }) {
    super(
      `Timeout (${ctx.timeoutMs}ms) llamando a ${ctx.system ?? 'sistema externo'} en ${ctx.url} tras ${ctx.attempt} intento(s)`,
      ctx,
    );
    this.timeoutMs = ctx.timeoutMs;
  }
}

/**
 * Fallo de red (ECONNRESET, ECONNREFUSED, ENOTFOUND, corte durante la lectura
 * del cuerpo, …) tras agotar reintentos. Los fallos deterministas del propio
 * cliente HTTP (`ERR_INVALID_URL`, header inválido) llegan aquí sin reintentos.
 */
export class IntegrationNetworkError extends IntegrationError {
  /** Código de error de Node/undici cuando está disponible. */
  readonly code?: string;

  constructor(ctx: IntegrationErrorContext & { code?: string }) {
    super(
      `Fallo de red${ctx.code ? ` (${ctx.code})` : ''} llamando a ${ctx.system ?? 'sistema externo'} en ${ctx.url} tras ${ctx.attempt} intento(s)`,
      ctx,
    );
    this.code = ctx.code;
  }
}
