import { ConfigService } from '@nestjs/config';

/**
 * Configuración del SYNC de SAP (Fase INT-4). Separada de `sap.config.ts` a
 * propósito, mismo criterio que Maximo: la config del cliente NO lee la
 * bandera de sincronización. `SAP_SYNC_ENABLED` gobierna TODO (cron y
 * disparo manual). Default de producción: false — se enciende explícitamente
 * en el despliegue (plan de Int-4).
 */
export interface SapSyncConfig {
  /** SAP_SYNC_ENABLED (default false). */
  enabled: boolean;
  /** SAP_SYNC_INTERVAL_MINUTES (default 60). */
  intervalMinutes: number;
  /**
   * SAP_SYNC_PAGE_SIZE para `$top` (default 20). Los documentos pesan
   * ~32 KB (líneas completas, sin proyección posible): 20 ≈ 640 KB/página.
   */
  pageSize: number;
  /**
   * L1 (2026-10-08): SAP_SYNC_FULL_DAILY_AT, hora local de México
   * (`SAP_SYNC_FULL_DAILY_TIME_ZONE`) del full diario (`SAP_FULL_DAILY_TARGETS`),
   * normalizada a `HH:MM` (default 03:00). null = apagado
   * (`SAP_SYNC_FULL_DAILY_AT=off`). Con `enabled` en false no corre aunque
   * tenga hora.
   */
  fullDailyAt: string | null;
}

export const SAP_SYNC_CONFIG = 'SAP_SYNC_CONFIG';

export const SAP_SYNC_DEFAULT_INTERVAL_MINUTES = 60;
export const SAP_SYNC_DEFAULT_PAGE_SIZE = 20;
export const SAP_SYNC_DEFAULT_FULL_DAILY_AT = '03:00';
/** L1: zona de la hora del full diario (el server puede estar en UTC). */
export const SAP_SYNC_FULL_DAILY_TIME_ZONE = 'America/Mexico_City';
/** L1: valor de SAP_SYNC_FULL_DAILY_AT que apaga el full diario. */
export const SAP_SYNC_FULL_DAILY_OFF = 'off';

function parseBoolean(value: unknown): boolean {
  return (
    value === true || (typeof value === 'string' && value.trim() === 'true')
  );
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * L1: `H:MM` / `HH:MM` (24 h) → `{ hour, minute }`; null si no es una hora
 * válida. Es la misma regla que valida Joi en `env.validation.ts`.
 */
export function parseDailyTime(
  value: string,
): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * L1: `off` → null (apagado); hora válida → `HH:MM`; vacío o inválido → el
 * default (Joi ya rechaza un valor inválido al arrancar; esto cubre los tests
 * y los arranques sin validación).
 */
function parseFullDailyAt(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === SAP_SYNC_FULL_DAILY_OFF) return null;
  const time = parseDailyTime(text);
  if (!time) return SAP_SYNC_DEFAULT_FULL_DAILY_AT;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(time.hour)}:${pad(time.minute)}`;
}

export function loadSapSyncConfig(config: ConfigService): SapSyncConfig {
  return {
    enabled: parseBoolean(config.get<boolean | string>('SAP_SYNC_ENABLED')),
    intervalMinutes: parsePositiveInt(
      config.get<number | string>('SAP_SYNC_INTERVAL_MINUTES'),
      SAP_SYNC_DEFAULT_INTERVAL_MINUTES,
    ),
    pageSize: parsePositiveInt(
      config.get<number | string>('SAP_SYNC_PAGE_SIZE'),
      SAP_SYNC_DEFAULT_PAGE_SIZE,
    ),
    fullDailyAt: parseFullDailyAt(config.get<string>('SAP_SYNC_FULL_DAILY_AT')),
  };
}
