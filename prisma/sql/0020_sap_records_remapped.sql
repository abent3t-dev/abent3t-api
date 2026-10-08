-- =============================================================================
-- 0020_sap_records_remapped.sql — 'remapped' en el sync de SAP (bloque L, L1)
--
-- Aditiva; NO rellena datos (las corridas anteriores quedan en 0).
--
--   * L1 sap_sync_runs.records_remapped: filas con el mismo raw_hash
--        re-mapeadas por un SAP_MAPPER_VERSION nuevo, como K8 en Maximo. No
--        tocan last_changed_at; 'updated' queda solo para un raw distinto
--        (cambio real en SAP). Antes, subir el mapper marcaba las 3,395 OC
--        como 'updated'.
--
-- El full diario de OC, solicitudes y proveedores (SAP_SYNC_FULL_DAILY_AT) no
-- necesita esquema: usa sap_sync_runs con mode='full' y triggered_by='cron'.
-- =============================================================================

BEGIN;

ALTER TABLE sap_sync_runs
  ADD COLUMN records_remapped int NOT NULL DEFAULT 0;

COMMENT ON COLUMN sap_sync_runs.records_remapped IS
  'L1: filas con el mismo raw_hash re-mapeadas por un SAP_MAPPER_VERSION nuevo; no tocan last_changed_at.';

COMMIT;
