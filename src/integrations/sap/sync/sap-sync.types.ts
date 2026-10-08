/**
 * Tipos compartidos del sync de SAP (Fase INT-4). Los literales espejan los
 * enums de Postgres creados en `prisma/sql/0009_sap_staging.sql`.
 */
export type SapSyncTarget =
  | 'purchase_orders'
  | 'purchase_requests'
  | 'business_partners'
  | 'approval_requests';
export type SapSyncTrigger = 'cron' | 'manual';
export type SapSyncRunStatus = 'running' | 'success' | 'partial' | 'failed';
/**
 * full = barrido completo; incremental = solo documentos con
 * UpdateDate >= corte (máximo update_date_source en staging − margen).
 */
export type SapSyncMode = 'full' | 'incremental';

export const SAP_SYNC_TARGETS: readonly SapSyncTarget[] = [
  'purchase_orders',
  'purchase_requests',
  'business_partners',
  'approval_requests',
];

/**
 * Resultado de un upsert individual de staging.
 *
 * L1 (2026-10-08), como K8 en Maximo: 'remapped' = mismo `raw_hash` con otro
 * `SAP_MAPPER_VERSION`. Se re-mapean las columnas sin tocar
 * `last_changed_at`: el documento no cambió en SAP. 'updated' queda solo
 * para un `raw_hash` distinto (SAP no tiene rowstamp: el cambio real es otro
 * raw).
 */
export type SapUpsertOutcome =
  | 'inserted'
  | 'updated'
  | 'remapped'
  | 'unchanged';

/**
 * L1: targets del full diario (`SAP_SYNC_FULL_DAILY_AT`), en este orden. SAP
 * no mueve el `UpdateDate` de una OC o una solicitud cuando otro documento la
 * cierra, así que el incremental no ve esos cierres. Proveedores entran para
 * que el full también re-mapee sus filas tras subir el mapper (tardan
 * segundos). La cola de autorización no hace falta: ya corre full en cada
 * tick horario.
 */
export const SAP_FULL_DAILY_TARGETS: readonly SapSyncTarget[] = [
  'purchase_orders',
  'purchase_requests',
  'business_partners',
];

export interface SapSyncCounters {
  pagesTotal: number | null;
  pagesOk: number;
  pagesFailed: number;
  recordsFetched: number;
  recordsInserted: number;
  recordsUpdated: number;
  /** L1: mismo raw_hash re-mapeado por un mapper nuevo; no es cambio real. */
  recordsRemapped: number;
  recordsUnchanged: number;
  recordsFailed: number;
}

export interface SapSyncRunSummary extends SapSyncCounters {
  runId: string;
  target: SapSyncTarget;
  triggeredBy: SapSyncTrigger;
  mode: SapSyncMode;
  /** Corte del incremental (null en full). */
  sinceFilter: Date | null;
  status: SapSyncRunStatus;
  errorSummary: string | null;
}
