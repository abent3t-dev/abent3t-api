/**
 * Tipos compartidos del sync de Maximo (Fase INT-3). Los literales espejan
 * los enums de Postgres creados en `prisma/sql/0005_maximo_staging.sql`.
 */
export type MaximoSyncTarget = 'purchase_orders' | 'contracts';
export type MaximoSyncTrigger = 'cron' | 'manual' | 'seed';
export type MaximoSyncRunStatus = 'running' | 'success' | 'partial' | 'failed';

export const MAXIMO_SYNC_TARGETS: readonly MaximoSyncTarget[] = [
  'purchase_orders',
  'contracts',
];

/** Resultado de un upsert individual de staging. */
export type MaximoUpsertOutcome = 'inserted' | 'updated' | 'unchanged';

export interface MaximoSyncCounters {
  pagesTotal: number | null;
  pagesOk: number;
  pagesFailed: number;
  recordsFetched: number;
  recordsInserted: number;
  recordsUpdated: number;
  recordsUnchanged: number;
  recordsFailed: number;
}

export interface MaximoSyncRunSummary extends MaximoSyncCounters {
  runId: string;
  target: MaximoSyncTarget;
  triggeredBy: MaximoSyncTrigger;
  status: MaximoSyncRunStatus;
  filterWarnings: unknown[];
  errorSummary: string | null;
}

/** Resultado de syncContracts cuando MAXIMO_CONTRACTS_ENABLED=false. */
export interface MaximoSyncSkipped {
  skipped: true;
  target: MaximoSyncTarget;
  reason: string;
}

export function isSyncSkipped(
  value: MaximoSyncRunSummary | MaximoSyncSkipped,
): value is MaximoSyncSkipped {
  return (value as MaximoSyncSkipped).skipped === true;
}
