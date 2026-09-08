import { Logger } from '@nestjs/common';

/**
 * Logging de llamadas salientes a sistemas externos con redacción de secretos.
 *
 * Fase INT-1 (cierra parte de H10 de AUDITORIA_ESTRUCTURA.md). Regla dura:
 * NUNCA se loguea el valor de headers de autenticación (`MAXAUTH`, `Cookie`,
 * `Authorization`, `apikey`, …) ni de query params con credenciales (`_lid`/
 * `_lpwd` de la API legacy de Maximo, `token`, `password`, …). Tampoco se
 * loguean cuerpos. En el nivel debug solo se emiten NOMBRES de headers.
 */

/** Subconjunto del Logger de Nest que usa este módulo (inyectable en tests). */
export interface LoggerLike {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export const REDACTED = '[REDACTED]';

/** Headers cuyo valor jamás debe aparecer en logs (comparación case-insensitive). */
export const SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'maxauth',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'secret-access',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'b1session',
];

/** Query params cuyo valor se reemplaza por [REDACTED] en las URLs logueadas. */
export const SENSITIVE_QUERY_PARAMS: readonly string[] = [
  '_lid',
  '_lpwd',
  'token',
  'access_token',
  'apikey',
  'api_key',
  'api-key',
  'password',
  'pwd',
  'pass',
  'secret',
  'key',
  'sig',
  'signature',
  'session',
  'sessionid',
];

/**
 * Además de las listas exactas, cualquier nombre (header o query param) cuya
 * forma normalizada (minúsculas, sin `-`/`_`) contenga uno de estos fragmentos
 * se considera sensible. Evita que un header nuevo (p. ej. `X-Maximo-Token`)
 * se loguee en claro por no estar en la lista.
 */
const SENSITIVE_NAME_FRAGMENTS: readonly string[] = [
  'auth',
  'token',
  'secret',
  'apikey',
  'accesskey',
  'password',
  'passwd',
  'pwd',
  'cookie',
  'session',
  'credential',
  'signature',
];

const SENSITIVE_HEADER_SET = new Set(SENSITIVE_HEADERS);
const SENSITIVE_QUERY_SET = new Set(SENSITIVE_QUERY_PARAMS);

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}

function matchesFragment(name: string): boolean {
  const normalized = normalizeName(name);
  return SENSITIVE_NAME_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

/** `true` si el valor de este header nunca debe loguearse. */
export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_SET.has(name.toLowerCase()) || matchesFragment(name);
}

/** `true` si el valor de este query param nunca debe loguearse. */
export function isSensitiveQueryParam(name: string): boolean {
  return SENSITIVE_QUERY_SET.has(name.toLowerCase()) || matchesFragment(name);
}

/** Devuelve una copia de los headers con los valores sensibles redactados. */
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeaderName(name) ? REDACTED : value;
  }
  return out;
}

/**
 * Reemplaza el valor de los query params sensibles (y el userinfo) por
 * [REDACTED]. Si la URL no se puede parsear, descarta la query completa.
 */
export function sanitizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const idx = url.indexOf('?');
    return idx === -1 ? url : `${url.slice(0, idx)}?${REDACTED}`;
  }
  // userinfo (http://user:pass@host) tampoco se loguea.
  if (parsed.username || parsed.password) {
    parsed.username = REDACTED;
    parsed.password = '';
  }
  for (const name of Array.from(parsed.searchParams.keys())) {
    if (isSensitiveQueryParam(name)) {
      parsed.searchParams.set(name, REDACTED);
    }
  }
  // URL serializa `[`/`]` como %5B/%5D; se restaura el marcador legible.
  return parsed.toString().replace(/%5BREDACTED%5D/g, REDACTED);
}

export type IntegrationRequestOutcome = 'success' | 'retry' | 'failure';

export interface IntegrationRequestLog {
  method: 'GET';
  /** URL completa; se sanea dentro del logger, no hace falta pre-sanearla. */
  url: string;
  status?: number;
  /** Duración del intento incluyendo la lectura del cuerpo. */
  durationMs: number;
  attempt: number;
  maxAttempts: number;
  outcome: IntegrationRequestOutcome;
  /** Texto corto de diagnóstico (código de red, nombre de error). Sin cuerpos. */
  detail?: string;
  /** Espera antes del siguiente intento (solo outcome='retry'). */
  nextDelayMs?: number;
}

/**
 * Wrapper del Logger de Nest con contexto `Integration:<system>`.
 * Una instancia por cliente HTTP.
 */
export class IntegrationLogger {
  private readonly logger: LoggerLike;

  constructor(
    readonly system: string,
    logger?: LoggerLike,
  ) {
    this.logger = logger ?? new Logger(`Integration:${system}`);
  }

  /** Una línea por intento: método, URL saneada, status, duración, intento. */
  request(entry: IntegrationRequestLog): void {
    const parts = [
      entry.method,
      sanitizeUrl(entry.url),
      entry.status !== undefined ? `status=${entry.status}` : 'status=-',
      `${entry.durationMs}ms`,
      `attempt=${entry.attempt}/${entry.maxAttempts}`,
    ];
    if (entry.detail) parts.push(`detail=${entry.detail}`);
    if (entry.outcome === 'retry' && entry.nextDelayMs !== undefined) {
      parts.push(`retry_in=${entry.nextDelayMs}ms`);
    }
    const line = parts.join(' ');

    switch (entry.outcome) {
      case 'success':
        this.logger.log(line);
        break;
      case 'retry':
        this.logger.warn(line);
        break;
      case 'failure':
        this.logger.error(line);
        break;
    }
  }

  /**
   * Loguea (en debug) únicamente los NOMBRES de los headers enviados. Los
   * valores nunca se emiten: ni siquiera los "no sensibles" aportan algo.
   */
  headers(headers: Record<string, string>): void {
    if (!this.logger.debug) return;
    this.logger.debug(`headers=[${Object.keys(headers).join(', ')}]`);
  }
}
