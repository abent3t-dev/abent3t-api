import type { LoggerLike } from '../logging/integration-logger';

/**
 * Tipos del cliente HTTP transversal de integraciones (Fase INT-1).
 * El cliente es GET-only por diseño: no existe tipo para cuerpos de request.
 */

export type IntegrationQueryValue =
  | string
  | number
  | boolean
  | null
  | undefined;

/** Query params; `null`/`undefined` se omiten. */
export type IntegrationQuery = Record<string, IntegrationQueryValue>;

/**
 * Firma mínima de `fetch` que usa el cliente. Por defecto es el `fetch`
 * global de Node 22 (undici). Se inyecta en tests para no tocar la red.
 */
export type FetchLike = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: 'manual';
  },
) => Promise<Response>;

export type SleepFn = (ms: number) => Promise<void>;

export interface IntegrationHttpClientConfig {
  /** Identificador del sistema ('maximo', 'sap'); aparece en logs y errores. */
  system: string;
  /** URL base absoluta (http/https); las rutas de `get()` se concatenan a ella. */
  baseUrl: string;
  /** Timeout por intento (cabeceras + cuerpo). Default 30 000 ms. */
  timeoutMs?: number;
  /** Reintentos adicionales al primer intento. Default 3 (= 4 intentos). */
  maxRetries?: number;
  /** Base del backoff exponencial. Default 500 ms. */
  retryBaseDelayMs?: number;
  /** Tope de espera entre intentos. Default 10 000 ms. */
  retryMaxDelayMs?: number;
  /** Headers enviados en todas las llamadas (p. ej. auth). Nunca se loguean. */
  defaultHeaders?: Record<string, string>;

  // ---- Inyección para tests (no usar en producción) ----
  fetchImpl?: FetchLike;
  sleep?: SleepFn;
  /** Generador en [0, 1) para el jitter. Default Math.random. */
  random?: () => number;
  logger?: LoggerLike;
}

export interface IntegrationGetOptions {
  query?: IntegrationQuery;
  /** Headers adicionales para esta llamada (se mezclan sobre `defaultHeaders`). */
  headers?: Record<string, string>;
  /** Sobreescribe el timeout por intento de esta llamada. */
  timeoutMs?: number;
  /**
   * 'json' (default) parsea el cuerpo y falla con IntegrationRequestError si
   * no es JSON válido (un cuerpo vacío devuelve `data: undefined`).
   * 'text' devuelve el cuerpo crudo (p. ej. XML).
   */
  parseAs?: 'json' | 'text';
  /**
   * Hook opcional (Fase INT-3, tarea B): enriquece el `detail` de la línea de
   * log de ÉXITO con datos derivados de la respuesta (p. ej. rsTotal/rsCount
   * de Maximo). Solo afecta al log: si lanza, se ignora; el retorno se trunca.
   * NUNCA devolver secretos ni cuerpos completos.
   */
  onSuccessDetail?: (info: {
    status: number;
    data: unknown;
    attempts: number;
    durationMs: number;
  }) => string | undefined;
}

export interface IntegrationHttpResponse<T> {
  /** Cuerpo parseado. `undefined` si el cuerpo venía vacío con parseAs 'json'. */
  data: T;
  status: number;
  /**
   * Headers de respuesta (nombres en minúsculas). Varios `set-cookie` quedan
   * colapsados aquí; usar `setCookie` para la lista completa. No loguear.
   */
  headers: Record<string, string>;
  /** Todos los `Set-Cookie` de la respuesta, uno por entrada. No loguear. */
  setCookie: string[];
  /** URL final solicitada, ya saneada (query params sensibles redactados). */
  url: string;
  /** Duración total incluyendo lectura del cuerpo y esperas de reintento. */
  durationMs: number;
  /** Intentos realizados (1 = éxito a la primera). */
  attempts: number;
}

export const INTEGRATION_HTTP_DEFAULTS = {
  timeoutMs: 30_000,
  maxRetries: 3,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 10_000,
} as const;

/** Tamaño máximo del cuerpo que se conserva en errores (diagnóstico). */
export const ERROR_BODY_MAX_CHARS = 500;
