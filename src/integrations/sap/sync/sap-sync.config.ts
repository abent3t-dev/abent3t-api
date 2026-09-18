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
}

export const SAP_SYNC_CONFIG = 'SAP_SYNC_CONFIG';

export const SAP_SYNC_DEFAULT_INTERVAL_MINUTES = 60;
export const SAP_SYNC_DEFAULT_PAGE_SIZE = 20;

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
  };
}
