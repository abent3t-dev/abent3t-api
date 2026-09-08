-- =============================================================================
-- 0005_maximo_staging.sql — Fase INT-3 (Compras · Integración Maximo)
--
-- Staging de SOLO LECTURA para lo que `MaximoClient` (Int-2) trae de IBM
-- Maximo. Nunca se escribe hacia Maximo (regla contractual H14/T2).
--
--   * maximo_sync_runs        — bitácora de corridas (cron | manual | seed)
--   * maximo_purchase_orders  — staging AB_COMPRAS, UNA fila por revisión
--   * maximo_contracts        — staging AB_CONTRATOS, UNA fila por revisión (T3)
--
-- Decisiones (CLAUDE_COMPRAS.md §20.B):
--   * T3: clave natural PO (ponum, siteid, revisionnum); contrato
--     (prnum, contractnum, revisionnum). Campos nullables → índices únicos
--     sobre expresiones coalesce (Prisma no los modela: el upsert va por
--     findFirst + create/update con manejo de carrera P2002).
--   * T4: full scan paginado; sin-cambio se detecta por rowstamp (PO) /
--     contract_rowstamp (contrato) y solo toca last_seen_at.
--   * El `raw` jsonb conserva el registro CRUDO tal como llegó de Maximo
--     (sin canonicalizar): permite re-mapear sin re-descargar
--     (script `maximo:remap`, columna mapper_version).
--   * Campos pendientes de Isaac (§20.A.2/7): contract_ref_num y
--     contract_value se persisten NULL; jamás se derivan de MAXVOL/CONTRACTNUM.
--   * Sin índice GIN sobre `raw`: no hay consultas por contenido del raw
--     todavía (el dominio leerá columnas mapeadas en Int-5); agregarlo cuando
--     exista un patrón de consulta que lo justifique.
-- =============================================================================

BEGIN;

CREATE TYPE maximo_sync_target  AS ENUM ('purchase_orders', 'contracts');
CREATE TYPE maximo_sync_trigger AS ENUM ('cron', 'manual', 'seed');
CREATE TYPE maximo_sync_status  AS ENUM ('running', 'success', 'partial', 'failed');

-- -----------------------------------------------------------------------------
-- Corridas de sincronización
-- -----------------------------------------------------------------------------
CREATE TABLE maximo_sync_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target               maximo_sync_target  NOT NULL,
  triggered_by         maximo_sync_trigger NOT NULL,
  triggered_by_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  status               maximo_sync_status NOT NULL DEFAULT 'running',
  pages_total          integer,
  pages_ok             integer NOT NULL DEFAULT 0,
  records_fetched      integer NOT NULL DEFAULT 0,
  records_inserted     integer NOT NULL DEFAULT 0,
  records_updated      integer NOT NULL DEFAULT 0,
  records_unchanged    integer NOT NULL DEFAULT 0,
  records_failed       integer NOT NULL DEFAULT 0,
  filter_warnings      jsonb,
  error_summary        text,
  mapper_version       text NOT NULL
);

CREATE INDEX idx_maximo_sync_runs_target_started
  ON maximo_sync_runs (target, started_at DESC);
CREATE INDEX idx_maximo_sync_runs_status
  ON maximo_sync_runs (status);

COMMENT ON TABLE maximo_sync_runs IS
  'Bitácora de corridas de sync Maximo (Int-3). triggered_by=seed solo en desarrollo (T5).';

-- -----------------------------------------------------------------------------
-- Staging AB_COMPRAS (una fila por revisión de PO — T3)
-- -----------------------------------------------------------------------------
CREATE TABLE maximo_purchase_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- clave natural
  ponum             varchar(50) NOT NULL,
  siteid            varchar(20),
  revisionnum       integer,
  -- columnas mapeadas (MaximoPurchaseOrderDto; nullables: población incremental)
  status            varchar(30),
  description       text,
  vendor_id         varchar(50),
  vendor_name       varchar(255),
  total_cost        numeric(15,2),
  currency          varchar(10),
  ab_ahorro         numeric(15,2),
  ab_tipocomp       varchar(50),
  ab_clasfpo        varchar(20),
  requested_by      varchar(100),
  department        varchar(100),
  approved_at       timestamptz,        -- primera POSTATUS con APPR literal
  created_at_source timestamptz,        -- PO.ORDERDATE
  rowstamp          varchar(100),       -- detección de cambios (T4)
  -- auditoría de sync
  raw               jsonb NOT NULL,
  mapper_version    text  NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_changed_at   timestamptz,
  last_sync_run_id  uuid REFERENCES maximo_sync_runs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX uq_maximo_po_natural_key
  ON maximo_purchase_orders (ponum, coalesce(siteid, ''), coalesce(revisionnum, 0));
CREATE INDEX idx_maximo_po_status      ON maximo_purchase_orders (status);
CREATE INDEX idx_maximo_po_approved_at ON maximo_purchase_orders (approved_at);
CREATE INDEX idx_maximo_po_last_seen   ON maximo_purchase_orders (last_seen_at);

COMMENT ON TABLE  maximo_purchase_orders IS
  'Staging de AB_COMPRAS (solo lectura desde Maximo). raw = registro crudo original.';
COMMENT ON COLUMN maximo_purchase_orders.raw IS
  'Registro CRUDO tal como llegó (legacy anidado/compacto u OSLC). Permite re-mapear sin re-descargar.';

-- -----------------------------------------------------------------------------
-- Staging AB_CONTRATOS (una fila por revisión de PURCHVIEW — T3)
-- -----------------------------------------------------------------------------
CREATE TABLE maximo_contracts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- clave natural (prnum null en la estructura previa raíz-PURCHVIEW)
  prnum             varchar(50),
  contractnum       varchar(50),
  revisionnum       integer,
  -- columnas mapeadas (MaximoContractDto)
  status            varchar(30),
  maxvol            numeric(15,2),
  total_cost        numeric(15,2),      -- consumo (PURCHVIEW.TOTALCOST)
  currency          varchar(10),
  start_date        timestamptz,
  end_date          timestamptz,
  vendor_id         varchar(50),
  vendor_name       varchar(255),
  requested_by      varchar(100),
  department        varchar(100),
  approved_at       timestamptz,        -- primera CONTRACTSTATUS con APPR literal
  created_at_source timestamptz,        -- regla WAPPR (null si no hay WAPPR)
  contract_ref_num  varchar(50),        -- §20.A.2: pendiente Isaac → NULL
  contract_value    numeric(15,2),      -- §20.A.2: pendiente Isaac → NULL
  purchview_count   integer NOT NULL DEFAULT 1,
  has_contract      boolean NOT NULL DEFAULT false,
  pr_rowstamp       varchar(100),
  contract_rowstamp varchar(100),       -- detección de cambios (T3/T4)
  -- auditoría de sync
  raw               jsonb NOT NULL,     -- registro PR/PURCHVIEW crudo COMPLETO
  mapper_version    text  NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_changed_at   timestamptz,
  last_sync_run_id  uuid REFERENCES maximo_sync_runs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX uq_maximo_contract_natural_key
  ON maximo_contracts (coalesce(prnum, ''), coalesce(contractnum, ''), coalesce(revisionnum, 0));
CREATE INDEX idx_maximo_contract_status    ON maximo_contracts (status);
CREATE INDEX idx_maximo_contract_end_date  ON maximo_contracts (end_date);
CREATE INDEX idx_maximo_contract_last_seen ON maximo_contracts (last_seen_at);

COMMENT ON TABLE  maximo_contracts IS
  'Staging de AB_CONTRATOS, una fila por revisión (T3). CONTRACTLINE/CONTRACTSTATUS/COMPANIES completos viven en raw.';
COMMENT ON COLUMN maximo_contracts.contract_ref_num IS
  'Pendiente Isaac (§20.A.2). NULL hasta confirmación; nunca derivado de CONTRACTNUM.';
COMMENT ON COLUMN maximo_contracts.contract_value IS
  'Pendiente Isaac (§20.A.2). NULL hasta confirmación; nunca derivado de MAXVOL.';

-- -----------------------------------------------------------------------------
-- Permisos (mismo patrón que 0004). DELETE solo en staging: lo usa
-- exclusivamente maximo:seed-clear (dev) para retirar filas sembradas.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE         ON maximo_sync_runs       TO abent3t_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON maximo_purchase_orders TO abent3t_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON maximo_contracts       TO abent3t_app;

COMMIT;
