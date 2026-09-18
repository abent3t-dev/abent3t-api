/**
 * Tipos compartidos del sync de SAP (Fase INT-4). Los literales espejan los
 * enums de Postgres creados en `prisma/sql/0009_sap_staging.sql`.
 */
export type SapSyncTarget =
  | 'purchase_orders'
  | 'purchase_requests'
  | 'business_partners';
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
];

/** Resultado de un upsert individual de staging. */
export type SapUpsertOutcome = 'inserted' | 'updated' | 'unchanged';

export interface SapSyncCounters {
  pagesTotal: number | null;
  pagesOk: number;
  pagesFailed: number;
  recordsFetched: number;
  recordsInserted: number;
  recordsUpdated: number;
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
