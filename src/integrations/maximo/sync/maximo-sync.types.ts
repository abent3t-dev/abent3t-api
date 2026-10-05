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

/**
 * Resultado de un upsert individual de staging.
 *
 * K8 (2026-10-05): 'remapped' = mismo rowstamp, pero con otro mapper o con
 * otro hash del payload (un campo nuevo de CIISA o un cambio solo en hijos
 * que no mueve el rowstamp de la raíz). Se reescribe la fila sin tocar
 * `last_changed_at`: no es un cambio real en Maximo. 'updated' queda solo
 * para un rowstamp distinto.
 */
export type MaximoUpsertOutcome =
  | 'inserted'
  | 'updated'
  | 'remapped'
  | 'unchanged';

/** K8: por qué se re-mapeó una fila con el mismo rowstamp. */
export type MaximoRemapReason = 'mapper' | 'hash';

/** K8: lo que regresa staging por fila (la llave sirve de ejemplo en el log). */
export interface MaximoUpsertResult {
  outcome: MaximoUpsertOutcome;
  /** Solo con 'remapped': 'mapper' si cambió la versión, si no 'hash'. */
  reason?: MaximoRemapReason;
  /** Clave natural legible: `ponum|siteid|rev` o `prnum|contractnum|rev`. */
  key: string;
}

export interface MaximoSyncCounters {
  pagesTotal: number | null;
  pagesOk: number;
  pagesFailed: number;
  recordsFetched: number;
  recordsInserted: number;
  recordsUpdated: number;
  /** K8: mismo rowstamp re-mapeado (mapper o hash); no es cambio real. */
  recordsRemapped: number;
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
