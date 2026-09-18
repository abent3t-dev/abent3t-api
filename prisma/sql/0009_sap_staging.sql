-- =============================================================================
-- 0009_sap_staging.sql — Fase INT-4 (Compras · Integración SAP Business One)
--
-- Staging de SOLO LECTURA para lo que `SapClient` (Int-4) trae del Service
-- Layer de SAP B1. Nunca se escribe hacia SAP (regla contractual H14/T2).
--
--   * sap_sync_runs          — bitácora de corridas (cron | manual)
--   * sap_purchase_orders    — staging de PurchaseOrders (OC), una fila por DocEntry
--   * sap_purchase_requests  — staging de PurchaseRequests (Solicitudes de
--                              Pedido), una fila por DocEntry
--
-- Decisiones (validadas en vivo contra PRD_ABENT el 2026-09-17):
--   * Clave natural = DocEntry (entero, inmutable, único por entidad en SAP).
--     A diferencia de Maximo NO hay revisiones: el documento se actualiza in
--     place, así que el upsert es por DocEntry directo (índice único normal).
--   * Detección de cambios por `raw_hash` (sha256 del JSON crudo): `UpdateDate`
--     de SAP tiene granularidad de DÍA (00:00:00Z) y no distingue dos cambios
--     el mismo día. Sin cambio → solo se toca last_seen_at.
--   * El `raw` jsonb conserva el documento completo con sus DocumentLines
--     (el Service Layer no permite proyectar campos DE LÍNEA: `$expand` da
--     400 y `$select=DocumentLines` trae las líneas enteras, ~32 KB/doc).
--     Permite re-mapear sin re-descargar (columna mapper_version).
--   * Los 3 UDF de compras (U_Clas_gts / U_Imp_ahorro / U_Proc_Comp) son de
--     LÍNEA. El default del ERP ("SELECCIONAR" / null) cuenta como SIN DATO:
--     lines_classified y ahorro_total solo suman capturas reales. `ahorro_total`
--     NULL = ninguna línea trae ahorro (nunca se inventa 0 — decisión T10).
--   * `doc_total` en PurchaseRequests se calcula sumando LineTotal de las
--     líneas: el Service Layer rechaza `$select=DocTotal` en esa entidad
--     (validado: 400), igual que CardCode/CardName (las PR usan Requester).
-- =============================================================================

BEGIN;

CREATE TYPE sap_sync_target  AS ENUM ('purchase_orders', 'purchase_requests');
CREATE TYPE sap_sync_trigger AS ENUM ('cron', 'manual');
CREATE TYPE sap_sync_status  AS ENUM ('running', 'success', 'partial', 'failed');

-- -----------------------------------------------------------------------------
-- Corridas de sincronización
-- -----------------------------------------------------------------------------
CREATE TABLE sap_sync_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target               sap_sync_target  NOT NULL,
  triggered_by         sap_sync_trigger NOT NULL,
  triggered_by_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  mode                 varchar(20) NOT NULL DEFAULT 'full', -- full | incremental
  since_filter         timestamptz,                         -- corte del incremental (null = full)
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  status               sap_sync_status NOT NULL DEFAULT 'running',
  pages_total          integer,
  pages_ok             integer NOT NULL DEFAULT 0,
  records_fetched      integer NOT NULL DEFAULT 0,
  records_inserted     integer NOT NULL DEFAULT 0,
  records_updated      integer NOT NULL DEFAULT 0,
  records_unchanged    integer NOT NULL DEFAULT 0,
  records_failed       integer NOT NULL DEFAULT 0,
  error_summary        text,
  mapper_version       text NOT NULL
);

CREATE INDEX idx_sap_sync_runs_target_started
  ON sap_sync_runs (target, started_at DESC);
CREATE INDEX idx_sap_sync_runs_status
  ON sap_sync_runs (status);

COMMENT ON TABLE sap_sync_runs IS
  'Bitácora de corridas de sync SAP (Int-4). mode=incremental usa $filter=UpdateDate ge since_filter.';

-- -----------------------------------------------------------------------------
-- Staging PurchaseOrders (una fila por DocEntry)
-- -----------------------------------------------------------------------------
CREATE TABLE sap_purchase_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- clave natural
  doc_entry          integer NOT NULL,
  -- columnas mapeadas (nullables: campos aún sin capturar en el ERP)
  doc_num            integer,
  doc_date           timestamptz,
  doc_due_date       timestamptz,
  update_date_source timestamptz,        -- UpdateDate de SAP (granularidad día)
  document_status    varchar(30),        -- bost_Open | bost_Close (valor fuente)
  comments           text,
  card_code          varchar(50),        -- proveedor
  card_name          varchar(255),
  doc_total          numeric(15,2),
  currency           varchar(10),
  lines_total        integer NOT NULL DEFAULT 0,
  lines_classified   integer NOT NULL DEFAULT 0,  -- líneas con U_Clas_gts REAL (≠ default)
  ahorro_total       numeric(15,2),      -- suma de U_Imp_ahorro reales; NULL = sin dato (T10)
  -- auditoría de sync
  raw_hash           varchar(64) NOT NULL, -- sha256 del raw (detección de cambios)
  raw                jsonb NOT NULL,
  mapper_version     text  NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_changed_at    timestamptz,
  last_sync_run_id   uuid REFERENCES sap_sync_runs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX uq_sap_po_doc_entry ON sap_purchase_orders (doc_entry);
CREATE INDEX idx_sap_po_doc_date    ON sap_purchase_orders (doc_date);
CREATE INDEX idx_sap_po_status      ON sap_purchase_orders (document_status);
CREATE INDEX idx_sap_po_update_date ON sap_purchase_orders (update_date_source);

COMMENT ON TABLE  sap_purchase_orders IS
  'Staging de PurchaseOrders de SAP B1 (solo lectura desde SAP). raw = documento crudo con DocumentLines.';
COMMENT ON COLUMN sap_purchase_orders.ahorro_total IS
  'Suma de U_Imp_ahorro con valor real. NULL = ninguna línea lo trae capturado; nunca se muestra como 0 (T10).';

-- -----------------------------------------------------------------------------
-- Staging PurchaseRequests (una fila por DocEntry)
-- -----------------------------------------------------------------------------
CREATE TABLE sap_purchase_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_entry          integer NOT NULL,
  doc_num            integer,
  doc_date           timestamptz,
  doc_due_date       timestamptz,
  required_date      timestamptz,        -- RequriedDate (sic, así se llama en SAP)
  update_date_source timestamptz,
  document_status    varchar(30),
  comments           text,
  requester          varchar(100),       -- usuario SAP solicitante
  requester_name     varchar(255),
  doc_total          numeric(15,2),      -- SUMA de LineTotal (ver cabecera del archivo)
  currency           varchar(10),        -- moneda de la primera línea; NULL si sin líneas
  lines_total        integer NOT NULL DEFAULT 0,
  lines_classified   integer NOT NULL DEFAULT 0,
  ahorro_total       numeric(15,2),
  raw_hash           varchar(64) NOT NULL,
  raw                jsonb NOT NULL,
  mapper_version     text  NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_changed_at    timestamptz,
  last_sync_run_id   uuid REFERENCES sap_sync_runs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX uq_sap_pr_doc_entry ON sap_purchase_requests (doc_entry);
CREATE INDEX idx_sap_pr_doc_date    ON sap_purchase_requests (doc_date);
CREATE INDEX idx_sap_pr_status      ON sap_purchase_requests (document_status);
CREATE INDEX idx_sap_pr_update_date ON sap_purchase_requests (update_date_source);

COMMENT ON TABLE sap_purchase_requests IS
  'Staging de PurchaseRequests (Solicitudes de Pedido) de SAP B1. doc_total = suma de LineTotal.';

-- -----------------------------------------------------------------------------
-- Permisos (mismo patrón que 0005; sin DELETE: no hay seed de SAP)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON sap_sync_runs         TO abent3t_app;
GRANT SELECT, INSERT, UPDATE ON sap_purchase_orders   TO abent3t_app;
GRANT SELECT, INSERT, UPDATE ON sap_purchase_requests TO abent3t_app;

COMMIT;
