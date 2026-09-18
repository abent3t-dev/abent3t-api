import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { FetchLike } from '../common';
import { SapLoginError } from './sap.errors';

/**
 * Transporte HTTP del cliente SAP (Fase INT-4), sobre `node:https`.
 *
 * ¿Por qué no el `fetch` global? El Service Layer de TEST usa certificado
 * TLS propio y `SL_REJECT_UNAUTHORIZED=false` debe aplicarse POR CONEXIÓN:
 * el fetch de Node (undici) no expone `rejectUnauthorized` sin dependencias
 * nuevas, y tocar `NODE_TLS_REJECT_UNAUTHORIZED` global desactivaría la
 * verificación TLS de TODO el proceso (Graph, Entra, MinIO…). Joi ya impide
 * `false` en producción.
 *
 * Este módulo expone exactamente dos caminos:
 *  - `createSapFetch()` → un `FetchLike` GET-only para `IntegrationHttpClient`.
 *  - `postSapLogin()`   → el ÚNICO POST de toda la capa de integraciones
 *    (decisión T2): el path `/Login` es una CONSTANTE interna — no existe
 *    parámetro de path, por lo que es estructuralmente imposible usar esta
 *    función para escribir en SAP.
 */

export interface SapTlsOptions {
  rejectUnauthorized: boolean;
}

interface RawResponse {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

/** Petición https genérica de este transporte. `body` presente solo en el login. */
function rawRequest(opts: {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  tls: SapTlsOptions;
  signal?: AbortSignal;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(opts.url);
    } catch {
      reject(
        Object.assign(new Error('URL inválida para el transporte SAP'), {
          code: 'ERR_INVALID_URL',
        }),
      );
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(
        Object.assign(
          new Error('El transporte SAP solo acepta https (Service Layer)'),
          { code: 'ERR_INVALID_URL' },
        ),
      );
      return;
    }

    const req = httpsRequest(
      parsed,
      {
        method: opts.method,
        headers: opts.headers,
        rejectUnauthorized: opts.tls.rejectUnauthorized,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );

    const onAbort = () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      req.destroy(err);
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    req.on('error', reject);
    req.on('close', () => {
      opts.signal?.removeEventListener('abort', onAbort);
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Headers de node:http → `Headers` (con set-cookie multivalor preservado). */
function toHeaders(raw: IncomingMessage['headers']): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.append(name, value);
    }
  }
  return headers;
}

/**
 * `FetchLike` GET-only para `IntegrationHttpClient`. Devuelve un objeto con
 * la superficie de `Response` que el cliente usa (status/ok/headers/text);
 * el cast es inevitable porque `Response` completo no es construible sobre
 * node:https sin duplicar undici.
 */
export function createSapFetch(tls: SapTlsOptions): FetchLike {
  return async (url, init) => {
    const raw = await rawRequest({
      url,
      method: 'GET',
      headers: init.headers,
      tls,
      signal: init.signal,
    });
    const headers = toHeaders(raw.headers);
    const responseLike = {
      status: raw.status,
      ok: raw.status >= 200 && raw.status < 300,
      headers,
      text: () => Promise.resolve(raw.body),
    };
    return responseLike as unknown as Response;
  };
}

// ---------------------------------------------------------------------------
// Login — el único POST (T2)
// ---------------------------------------------------------------------------

/** Allowlist dura: el único path escribible del Service Layer que existe aquí. */
const LOGIN_PATH = '/Login';

export interface SapLoginParams {
  baseUrl: string;
  companyDb: string;
  userName: string;
  password: string;
  tls: SapTlsOptions;
  timeoutMs: number;
}

export interface SapLoginResult {
  /** Pares `nombre=valor` listos para el header `Cookie`. No loguear. */
  cookieHeader: string;
  /** Minutos de vida de la sesión según SAP (default 30 si no lo informa). */
  sessionTimeoutMinutes: number;
}

const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;

/**
 * `POST /Login` del Service Layer. Devuelve el cookie jar (B1SESSION +
 * ROUTEID) y el timeout de sesión. En fallo lanza `SapLoginError` con el
 * `error.message` de SAP — nunca la contraseña.
 */
export async function postSapLogin(
  params: SapLoginParams,
): Promise<SapLoginResult> {
  const url = `${params.baseUrl.replace(/\/+$/, '')}${LOGIN_PATH}`;
  const body = JSON.stringify({
    CompanyDB: params.companyDb,
    UserName: params.userName,
    Password: params.password,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  let raw: RawResponse;
  try {
    raw = await rawRequest({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
      tls: params.tls,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const name = (err as { name?: string } | null)?.name;
    const code = (err as { code?: string } | null)?.code;
    if (name === 'AbortError') {
      throw new SapLoginError(0, `timeout tras ${params.timeoutMs} ms`);
    }
    throw new SapLoginError(0, `error de red (${code ?? name ?? 'unknown'})`);
  } finally {
    clearTimeout(timer);
  }

  if (raw.status !== 200) {
    throw new SapLoginError(raw.status, extractSapErrorMessage(raw.body));
  }

  const setCookies = raw.headers['set-cookie'] ?? [];
  const pairs = setCookies
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.length > 0);
  if (!pairs.some((c) => c.startsWith('B1SESSION='))) {
    throw new SapLoginError(
      raw.status,
      'login OK pero sin cookie B1SESSION: no se puede mantener sesión',
    );
  }

  let sessionTimeoutMinutes = DEFAULT_SESSION_TIMEOUT_MINUTES;
  try {
    const parsed = JSON.parse(raw.body) as { SessionTimeout?: unknown };
    if (
      typeof parsed.SessionTimeout === 'number' &&
      Number.isFinite(parsed.SessionTimeout) &&
      parsed.SessionTimeout > 0
    ) {
      sessionTimeoutMinutes = parsed.SessionTimeout;
    }
  } catch {
    // Cuerpo no-JSON con 200: se conserva el default de 30 min.
  }

  return { cookieHeader: pairs.join('; '), sessionTimeoutMinutes };
}

/** Extrae `error.message` del cuerpo de error del Service Layer (truncado). */
function extractSapErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown };
    } | null;
    const message = parsed?.error?.message;
    if (typeof message === 'string' && message.trim() !== '') {
      return message.slice(0, 200);
    }
  } catch {
    // sigue abajo con el cuerpo crudo truncado
  }
  const trimmed = body.trim();
  return trimmed === '' ? '(sin cuerpo)' : trimmed.slice(0, 200);
}
