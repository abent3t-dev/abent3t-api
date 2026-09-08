import { ConfigService } from '@nestjs/config';

/**
 * Configuración del SYNC de Maximo (Fase INT-3). Separada de `maximo.config.ts`
 * a propósito: la config de Int-2 (cliente) NO lee la bandera de sincronización
 * y así lo pinza su spec. Aquí sí se lee: `MAXIMO_SYNC_ENABLED` gobierna TODO
 * (cron, disparo manual). Default de producción: false hasta cerrar OS con
 * Isaac (CLAUDE_COMPRAS.md §20.A.9).
 */
export interface MaximoSyncConfig {
  /** MAXIMO_SYNC_ENABLED (default false). */
  enabled: boolean;
  /** MAXIMO_SYNC_INTERVAL_MINUTES (default 60, §20.A.3). */
  intervalMinutes: number;
  /** MAXIMO_SYNC_PAGE_SIZE para `_maxItems` legacy (default 100, T4). */
  pageSize: number;
}

export const MAXIMO_SYNC_CONFIG = 'MAXIMO_SYNC_CONFIG';

export const MAXIMO_SYNC_DEFAULT_INTERVAL_MINUTES = 60;
export const MAXIMO_SYNC_DEFAULT_PAGE_SIZE = 100;

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

export function loadMaximoSyncConfig(config: ConfigService): MaximoSyncConfig {
  return {
    enabled: parseBoolean(config.get<boolean | string>('MAXIMO_SYNC_ENABLED')),
    intervalMinutes: parsePositiveInt(
      config.get<number | string>('MAXIMO_SYNC_INTERVAL_MINUTES'),
      MAXIMO_SYNC_DEFAULT_INTERVAL_MINUTES,
    ),
    pageSize: parsePositiveInt(
      config.get<number | string>('MAXIMO_SYNC_PAGE_SIZE'),
      MAXIMO_SYNC_DEFAULT_PAGE_SIZE,
    ),
  };
}
