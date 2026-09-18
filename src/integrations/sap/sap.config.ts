import { ConfigService } from '@nestjs/config';

/**
 * Configuración del cliente SAP B1 Service Layer (Fase INT-4). Solo lee las
 * env vars `SL_*` ya declaradas en `env.validation.ts` (T1: credenciales por
 * env, nunca por BD).
 *
 * NO lee la bandera de sincronización (SAP_SYNC_*): eso es de `sap/sync/`.
 * Si las variables están vacías (dev sin credenciales), el módulo arranca
 * igual y los métodos del cliente fallan con `SapNotConfiguredError` sin
 * tocar la red — mismo contrato que el cliente de Maximo.
 */
export interface SapConfig {
  /** `SL_BASE_URL` (https://host:50000/b1s/v2). null = no configurada. */
  baseUrl: string | null;
  /** `SL_COMPANY_DB` (tenant). null = no configurada. */
  companyDb: string | null;
  /** `SL_USER`. null = no configurada. Nunca se loguea. */
  user: string | null;
  /** `SL_PASSWORD`. null = no configurada. Nunca se loguea. */
  password: string | null;
  /**
   * `SL_REJECT_UNAUTHORIZED`. Joi impide `false` con NODE_ENV=production;
   * en TEST el Service Layer usa certificado propio y se tolera `false`.
   * El transporte lo aplica POR CONEXIÓN (jamás se toca
   * NODE_TLS_REJECT_UNAUTHORIZED global del proceso).
   */
  rejectUnauthorized: boolean;
  /** Timeout por intento. 60s, igual que Maximo/Crehana (redes lentas). */
  timeoutMs: number;
  maxRetries: number;
}

export const SAP_CONFIG = 'SAP_CONFIG';
/** Token opcional para inyectar un logger en tests; la app no lo provee. */
export const SAP_LOGGER = 'SAP_LOGGER';
/** Tokens opcionales SOLO para tests (login/reloj falsos); la app no los provee. */
export const SAP_LOGIN_FN = 'SAP_LOGIN_FN';
export const SAP_NOW_FN = 'SAP_NOW_FN';

export const SAP_DEFAULT_TIMEOUT_MS = 60_000;
export const SAP_DEFAULT_MAX_RETRIES = 3;

function emptyToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Joi ya convierte a boolean; se tolera también el string por robustez. */
function parseRejectUnauthorized(value: unknown): boolean {
  // Default seguro: true. Solo el literal false/'false' lo relaja.
  return !(
    value === false ||
    (typeof value === 'string' && value.trim() === 'false')
  );
}

export function loadSapConfig(config: ConfigService): SapConfig {
  return {
    baseUrl: emptyToNull(config.get<string>('SL_BASE_URL')),
    companyDb: emptyToNull(config.get<string>('SL_COMPANY_DB')),
    user: emptyToNull(config.get<string>('SL_USER')),
    password: emptyToNull(config.get<string>('SL_PASSWORD')),
    rejectUnauthorized: parseRejectUnauthorized(
      config.get<boolean | string>('SL_REJECT_UNAUTHORIZED'),
    ),
    timeoutMs: SAP_DEFAULT_TIMEOUT_MS,
    maxRetries: SAP_DEFAULT_MAX_RETRIES,
  };
}
