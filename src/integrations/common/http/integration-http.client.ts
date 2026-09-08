import {
  IntegrationAuthError,
  IntegrationNetworkError,
  IntegrationRequestError,
  IntegrationServerError,
  IntegrationTimeoutError,
} from '../errors/integration.errors';
import {
  IntegrationLogger,
  isSensitiveHeaderName,
  REDACTED,
  sanitizeUrl,
} from '../logging/integration-logger';
import {
  ERROR_BODY_MAX_CHARS,
  FetchLike,
  INTEGRATION_HTTP_DEFAULTS,
  IntegrationGetOptions,
  IntegrationHttpClientConfig,
  IntegrationHttpResponse,
  IntegrationQuery,
  SleepFn,
} from './integration-http.types';

/**
 * Cliente HTTP transversal de integraciones — Fase INT-1.
 *
 * GARANTÍA ESTRUCTURAL: la única operación pública es `get()`. No existe
 * `post/put/patch/delete` ni público ni privado; los helpers viven como
 * funciones de módulo, de modo que `Object.getOwnPropertyNames(prototype)`
 * es exactamente `['constructor', 'get']` (verificado por test). Las
 * integraciones con Maximo y SAP son de SOLO LECTURA por compromiso
 * contractual — ver CLAUDE_COMPRAS.md §Integraciones.
 *
 * Resiliencia:
 * - Timeout por intento que cubre cabeceras Y lectura del cuerpo.
 * - Reintentos con backoff exponencial + jitter ante errores de red (también
 *   durante la lectura del cuerpo), timeout, 5xx y 429 (respeta `Retry-After`).
 * - 401/403 → IntegrationAuthError sin reintentos.
 * - 4xx restantes, 3xx y 2xx no-JSON → IntegrationRequestError sin reintentos.
 * - Fallos deterministas del propio fetch (URL inválida, header inválido) no
 *   se reintentan.
 *
 * Higiene de secretos: el estado se guarda en campos `#privados` nativos (no
 * enumerables: `JSON.stringify(client)`/`util.inspect(client)` no exponen los
 * headers) y el `cause` de cada error es una copia depurada del original.
 *
 * Implementado sobre `fetch` nativo (Node 22 / undici), igual que el cliente
 * de Crehana ya existente; sin dependencias nuevas.
 */
export class IntegrationHttpClient {
  readonly #system: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #defaultHeaders: Record<string, string>;
  readonly #fetchImpl: FetchLike;
  readonly #sleep: SleepFn;
  readonly #random: () => number;
  readonly #log: IntegrationLogger;

  constructor(config: IntegrationHttpClientConfig) {
    if (!config.system?.trim()) {
      throw new Error('IntegrationHttpClient: `system` es obligatorio');
    }
    const prefix = `IntegrationHttpClient(${config.system})`;

    this.#system = config.system;
    this.#baseUrl = parseBaseUrl(config.baseUrl, prefix);
    this.#timeoutMs = assertPositiveNumber(
      config.timeoutMs ?? INTEGRATION_HTTP_DEFAULTS.timeoutMs,
      'timeoutMs',
      prefix,
    );
    this.#maxRetries = Math.floor(
      assertNonNegativeNumber(
        config.maxRetries ?? INTEGRATION_HTTP_DEFAULTS.maxRetries,
        'maxRetries',
        prefix,
      ),
    );
    this.#retryBaseDelayMs = assertNonNegativeNumber(
      config.retryBaseDelayMs ?? INTEGRATION_HTTP_DEFAULTS.retryBaseDelayMs,
      'retryBaseDelayMs',
      prefix,
    );
    this.#retryMaxDelayMs = assertNonNegativeNumber(
      config.retryMaxDelayMs ?? INTEGRATION_HTTP_DEFAULTS.retryMaxDelayMs,
      'retryMaxDelayMs',
      prefix,
    );
    this.#defaultHeaders = { ...(config.defaultHeaders ?? {}) };
    assertHeaderValues(this.#defaultHeaders, prefix);
    this.#fetchImpl = config.fetchImpl ?? defaultFetch;
    this.#sleep = config.sleep ?? defaultSleep;
    this.#random = config.random ?? Math.random;
    this.#log = new IntegrationLogger(config.system, config.logger);
  }

  /**
   * Única operación: GET.
   * Devuelve el cuerpo tipado + metadatos (status, duración, intentos).
   * El parseo/mapeo específico de cada sistema NO va aquí (Int-2 / Int-4).
   */
  async get<T = unknown>(
    path: string,
    options: IntegrationGetOptions = {},
  ): Promise<IntegrationHttpResponse<T>> {
    const prefix = `IntegrationHttpClient(${this.#system})`;
    assertHeaderValues(options.headers, prefix);

    const url = buildUrl(this.#baseUrl, path, options.query);
    const safeUrl = sanitizeUrl(url);
    const headers = { ...this.#defaultHeaders, ...(options.headers ?? {}) };
    const secrets = sensitiveHeaderValues(headers);
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const parseAs = options.parseAs ?? 'json';
    const maxAttempts = this.#maxRetries + 1;
    const startedAt = Date.now();

    this.#log.headers(headers);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStartedAt = Date.now();
      let fetched: FetchedResponse;

      try {
        fetched = await fetchAndRead(this.#fetchImpl, url, headers, timeoutMs);
      } catch (err: unknown) {
        const failure = classifyThrown(err);
        const durationMs = Date.now() - attemptStartedAt;

        if (failure.retryable && attempt < maxAttempts) {
          const nextDelayMs = computeDelay(
            attempt,
            this.#retryBaseDelayMs,
            this.#retryMaxDelayMs,
            this.#random,
          );
          this.#log.request({
            method: 'GET',
            url,
            durationMs,
            attempt,
            maxAttempts,
            outcome: 'retry',
            detail: failure.detail,
            nextDelayMs,
          });
          await this.#sleep(nextDelayMs);
          continue;
        }

        this.#log.request({
          method: 'GET',
          url,
          durationMs,
          attempt,
          maxAttempts,
          outcome: 'failure',
          detail: failure.detail,
        });
        const ctx = {
          system: this.#system,
          url: safeUrl,
          attempt,
          cause: scrubCause(err, url, safeUrl, secrets),
        };
        if (failure.kind === 'timeout') {
          throw new IntegrationTimeoutError({ ...ctx, timeoutMs });
        }
        throw new IntegrationNetworkError({ ...ctx, code: failure.code });
      }

      const durationMs = Date.now() - attemptStartedAt;
      const { status, ok, text } = fetched;
      const body = truncate(text);

      if (ok) {
        const parsed = parseBody<T>(text, parseAs);
        if (!parsed.ok) {
          this.#log.request({
            method: 'GET',
            url,
            status,
            durationMs,
            attempt,
            maxAttempts,
            outcome: 'failure',
            detail: 'invalid_body',
          });
          throw new IntegrationRequestError({
            system: this.#system,
            url: safeUrl,
            attempt,
            status,
            body,
            reason: 'Cuerpo de respuesta no es JSON válido',
            cause: scrubCause(parsed.error, url, safeUrl, secrets),
          });
        }
        this.#log.request({
          method: 'GET',
          url,
          status,
          durationMs,
          attempt,
          maxAttempts,
          outcome: 'success',
          detail: safeSuccessDetail(options.onSuccessDetail, {
            status,
            data: parsed.data,
            attempts: attempt,
            durationMs,
          }),
        });
        return {
          data: parsed.data,
          status,
          headers: headersToRecord(fetched.headers),
          setCookie: extractSetCookie(fetched.headers),
          url: safeUrl,
          durationMs: Date.now() - startedAt,
          attempts: attempt,
        };
      }

      if (status === 401 || status === 403) {
        this.#log.request({
          method: 'GET',
          url,
          status,
          durationMs,
          attempt,
          maxAttempts,
          outcome: 'failure',
          detail: 'auth',
        });
        throw new IntegrationAuthError({
          system: this.#system,
          url: safeUrl,
          attempt,
          status,
          body,
        });
      }

      const retryable = status >= 500 || status === 429;

      if (retryable && attempt < maxAttempts) {
        const retryAfterMs = parseRetryAfter(
          fetched.headers.get('retry-after'),
        );
        const nextDelayMs = computeDelay(
          attempt,
          this.#retryBaseDelayMs,
          this.#retryMaxDelayMs,
          this.#random,
          retryAfterMs,
        );
        this.#log.request({
          method: 'GET',
          url,
          status,
          durationMs,
          attempt,
          maxAttempts,
          outcome: 'retry',
          nextDelayMs,
        });
        await this.#sleep(nextDelayMs);
        continue;
      }

      this.#log.request({
        method: 'GET',
        url,
        status,
        durationMs,
        attempt,
        maxAttempts,
        outcome: 'failure',
      });
      const ctx = { system: this.#system, url: safeUrl, attempt, status, body };
      if (status >= 500) {
        throw new IntegrationServerError(ctx);
      }
      throw new IntegrationRequestError(
        status === 429
          ? { ...ctx, reason: 'Límite de peticiones (rate limit) agotado' }
          : ctx,
      );
    }

    // Inalcanzable: el bucle siempre retorna o lanza.
    throw new Error(`${prefix}: estado inesperado`);
  }
}

// ---------------------------------------------------------------------------
// Helpers de módulo (fuera de la clase a propósito: mantienen el prototipo
// público limitado a `get`).
// ---------------------------------------------------------------------------

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Valida que baseUrl sea absoluta http(s). El mensaje de error NO incluye la URL. */
function parseBaseUrl(baseUrl: string | undefined, prefix: string): string {
  if (!baseUrl?.trim()) {
    throw new Error(`${prefix}: \`baseUrl\` es obligatoria`);
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${prefix}: \`baseUrl\` debe ser una URL absoluta válida`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${prefix}: \`baseUrl\` debe usar http o https`);
  }
  return baseUrl.replace(/\/+$/, '');
}

function assertNonNegativeNumber(
  value: number,
  name: string,
  prefix: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${prefix}: \`${name}\` debe ser un número >= 0`);
  }
  return value;
}

function assertPositiveNumber(
  value: number,
  name: string,
  prefix: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${prefix}: \`${name}\` debe ser un número > 0`);
  }
  return value;
}

/**
 * undici rechaza valores de header con CR/LF/NUL con un TypeError cuyo
 * mensaje incluye el VALOR completo. Se valida antes para fallar rápido y
 * con un mensaje que solo nombra el header.
 */
function assertHeaderValues(
  headers: Record<string, string> | undefined,
  prefix: string,
): void {
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      throw new Error(
        `${prefix}: el header "${name}" tiene un valor inválido (debe ser string sin CR/LF/NUL)`,
      );
    }
  }
}

/** Valores de headers sensibles: se usan para depurar mensajes de error. */
function sensitiveHeaderValues(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([name, value]) => isSensitiveHeaderName(name) && value.length > 0)
    .map(([, value]) => value);
}

/** Concatena baseUrl + path y agrega query params (omitiendo null/undefined). */
function buildUrl(
  baseUrl: string,
  path: string,
  query?: IntegrationQuery,
): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new Error(
      'IntegrationHttpClient: `path` debe ser relativo a baseUrl (no se aceptan URLs absolutas)',
    );
  }
  const cleanPath = path.replace(/^\/+/, '');
  let url = cleanPath ? `${baseUrl}/${cleanPath}` : baseUrl;

  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

interface FetchedResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

/**
 * Ejecuta fetch Y lee el cuerpo completo dentro del mismo timeout. Aborta vía
 * AbortController y además compite con un temporizador, de modo que el
 * timeout se cumple aunque la implementación de fetch ignore la señal o el
 * cuerpo se quede colgado tras recibir las cabeceras.
 */
async function fetchAndRead(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<FetchedResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(`timeout after ${timeoutMs}ms`);
      err.name = 'AbortError';
      reject(err);
    }, timeoutMs);
  });

  const request = fetchImpl(url, {
    method: 'GET',
    headers,
    signal: controller.signal,
    redirect: 'manual',
  }).then(async (response) => ({
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    text: await response.text(),
  }));

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ThrownClassification {
  kind: 'timeout' | 'network';
  code?: string;
  detail: string;
  /** false para fallos deterministas del propio cliente (URL/header inválidos). */
  retryable: boolean;
}

const NON_RETRYABLE_CODES = new Set([
  'ERR_INVALID_URL',
  'ERR_INVALID_ARG_VALUE',
]);

/** Distingue timeout (abort) de fallo de red y extrae el código de undici/Node. */
function classifyThrown(err: unknown): ThrownClassification {
  const e = err as {
    name?: unknown;
    code?: unknown;
    cause?: unknown;
    message?: unknown;
  } | null;
  const name = typeof e?.name === 'string' ? e.name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { kind: 'timeout', detail: 'timeout', retryable: true };
  }
  const cause = e?.cause as { code?: unknown } | undefined;
  const code =
    typeof cause?.code === 'string'
      ? cause.code
      : typeof e?.code === 'string'
        ? e.code
        : undefined;
  const message = typeof e?.message === 'string' ? e.message : '';
  const deterministic =
    (code !== undefined && NON_RETRYABLE_CODES.has(code)) ||
    /invalid header|Headers\.append|ByteString|Failed to parse URL/i.test(
      message,
    );
  return {
    kind: 'network',
    code,
    detail: code ?? name ?? 'network_error',
    retryable: !deterministic,
  };
}

/**
 * Copia depurada de un error ajeno (fetch, JSON.parse): conserva nombre,
 * código y mensaje, pero reemplaza la URL cruda por la saneada y cualquier
 * valor de header sensible por [REDACTED]. Nunca conserva el objeto original
 * (undici adjunta `cause.input` con la URL completa).
 */
function scrubCause(
  err: unknown,
  rawUrl: string,
  safeUrl: string,
  secrets: string[],
): Error {
  const e = err as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
  } | null;
  const scrub = (text: string): string => {
    let out = text.split(rawUrl).join(safeUrl);
    const rawQuery = rawUrl.includes('?')
      ? rawUrl.slice(rawUrl.indexOf('?') + 1)
      : '';
    if (rawQuery) out = out.split(rawQuery).join(REDACTED);
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
    return out;
  };

  const name = typeof e?.name === 'string' ? e.name : 'Error';
  const message =
    typeof e?.message === 'string'
      ? e.message
      : typeof err === 'string'
        ? err
        : '';
  const scrubbed = new Error(scrub(message)) as Error & { code?: string };
  scrubbed.name = name;
  const code =
    typeof e?.code === 'string'
      ? e.code
      : typeof (e?.cause as { code?: unknown } | undefined)?.code === 'string'
        ? (e?.cause as { code: string }).code
        : undefined;
  if (code) scrubbed.code = code;

  const nested = e?.cause as { name?: unknown; message?: unknown } | undefined;
  if (nested && typeof nested.message === 'string') {
    scrubbed.cause = {
      name: typeof nested.name === 'string' ? nested.name : 'Error',
      message: scrub(nested.message),
      ...(code ? { code } : {}),
    };
  }
  return scrubbed;
}

/**
 * Backoff exponencial con "equal jitter": primero se acota el término
 * exponencial al tope y luego se aplica mitad fija + mitad aleatoria, de modo
 * que el jitter sobrevive al tope. Si el servidor mandó `Retry-After`, se
 * respeta como mínimo (también acotado por el tope).
 */
function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
  retryAfterMs?: number,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  let delay = exp / 2 + random() * (exp / 2);
  if (retryAfterMs !== undefined && retryAfterMs > delay) {
    delay = Math.min(maxDelayMs, retryAfterMs);
  }
  return Math.round(delay);
}

/** `Retry-After` en segundos o fecha HTTP → ms. `undefined` si falta o es inválido. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

const SUCCESS_DETAIL_MAX_CHARS = 200;

/**
 * Ejecuta el hook `onSuccessDetail` sin dejar que un fallo del caller rompa
 * la petición: excepciones ignoradas, retorno truncado, solo strings.
 */
function safeSuccessDetail(
  hook:
    | ((info: {
        status: number;
        data: unknown;
        attempts: number;
        durationMs: number;
      }) => string | undefined)
    | undefined,
  info: { status: number; data: unknown; attempts: number; durationMs: number },
): string | undefined {
  if (!hook) return undefined;
  try {
    const detail = hook(info);
    if (typeof detail !== 'string' || detail.length === 0) return undefined;
    return detail.length > SUCCESS_DETAIL_MAX_CHARS
      ? `${detail.slice(0, SUCCESS_DETAIL_MAX_CHARS)}…`
      : detail;
  } catch {
    return undefined;
  }
}

function truncate(text: string): string {
  return text.length > ERROR_BODY_MAX_CHARS
    ? `${text.slice(0, ERROR_BODY_MAX_CHARS)}…`
    : text;
}

type ParsedBody<T> = { ok: true; data: T } | { ok: false; error: unknown };

/** Parsea el cuerpo ya leído. Cuerpo vacío con 'json' → `undefined`. */
function parseBody<T>(text: string, parseAs: 'json' | 'text'): ParsedBody<T> {
  if (parseAs === 'text') {
    return { ok: true, data: text as unknown as T };
  }
  if (text.trim() === '') {
    return { ok: true, data: undefined as unknown as T };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err: unknown) {
    return { ok: false, error: err ?? new Error('invalid_json') };
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Lista completa de `Set-Cookie` (Headers.forEach los colapsa). */
function extractSetCookie(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') {
    return withGetter.getSetCookie();
  }
  const out: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') out.push(value);
  });
  return out;
}
