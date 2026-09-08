import { ConfigService } from '@nestjs/config';

/**
 * Configuración del cliente Maximo (Fase INT-2). Solo lee las env vars ya
 * declaradas en `env.validation.ts`: MAXIMO_BASE_URL, MAXIMO_OSLC_URL,
 * MAXIMO_AUTH_TOKEN y MAXIMO_CONTRACTS_ENABLED.
 *
 * NO lee la bandera de sincronización (MAXIMO_SYNC_*, es de Int-3): este módulo no sincroniza nada.
 * Si las URLs/token están vacíos (dev), el módulo arranca igual y los
 * métodos del cliente fallan con `MaximoNotConfiguredError` sin tocar la red.
 */
export interface MaximoConfig {
  /** REST legacy `/maxrest/rest/os`. null = no configurada. */
  baseUrl: string | null;
  /** OSLC `/maximo/oslc/os`. null = no configurada. */
  oslcUrl: string | null;
  /** Token Base64 del header MAXAUTH. null = no configurado. Nunca se loguea. */
  authToken: string | null;
  /** `MAXIMO_CONTRACTS_ENABLED` (default false, §20.2). */
  contractsEnabled: boolean;
  /** Timeout por intento. 60s como el cliente de Crehana (redes lentas). */
  timeoutMs: number;
  maxRetries: number;
}

export const MAXIMO_CONFIG = 'MAXIMO_CONFIG';
/** Token opcional para inyectar un logger en tests; la app no lo provee. */
export const MAXIMO_LOGGER = 'MAXIMO_LOGGER';

export const MAXIMO_DEFAULT_TIMEOUT_MS = 60_000;
export const MAXIMO_DEFAULT_MAX_RETRIES = 3;

function emptyToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Joi ya convierte a boolean; se tolera también el string por robustez. */
function parseBoolean(value: unknown): boolean {
  return (
    value === true || (typeof value === 'string' && value.trim() === 'true')
  );
}

export function loadMaximoConfig(config: ConfigService): MaximoConfig {
  return {
    baseUrl: emptyToNull(config.get<string>('MAXIMO_BASE_URL')),
    oslcUrl: emptyToNull(config.get<string>('MAXIMO_OSLC_URL')),
    authToken: emptyToNull(config.get<string>('MAXIMO_AUTH_TOKEN')),
    contractsEnabled: parseBoolean(
      config.get<boolean | string>('MAXIMO_CONTRACTS_ENABLED'),
    ),
    timeoutMs: MAXIMO_DEFAULT_TIMEOUT_MS,
    maxRetries: MAXIMO_DEFAULT_MAX_RETRIES,
  };
}
