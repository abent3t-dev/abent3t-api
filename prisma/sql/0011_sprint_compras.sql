-- =============================================================================
-- 0011_sprint_compras.sql — Sprint Compras 2026-09-22 → 25 (junta Ingrid/Omar)
--
-- Una sola migración con TODOS los cambios de esquema del sprint (menos pasos
-- en el Servidor B). Todas las columnas nuevas son NULLABLES: nada se rellena
-- con 0 ni con valores inventados — los datos llegan con el re-sync de SAP
-- (mode full), el remap de Maximo o la captura manual de Compras.
--
--   * A6  sap_purchase_orders / sap_purchase_requests: tercer estatus.
--         SAP distingue una OC/solicitud CANCELADA con `Cancelled`, no con
--         `DocumentStatus` (una cancelada llega como bost_Close). Se guardan
--         Cancelled / CancelStatus / AuthorizationStatus / Confirmed /
--         ClosingDate para derivar Abierta | Cerrada | Cancelada y mejorar los
--         días de gestión (ClosingDate en vez de UpdateDate).
--   * B3  maximo_purchase_orders.waiting_approval_at (primer WAPPR; el mapper
--         ya lo calculaba pero solo vivía en `raw`) + approved_by (CHANGEBY del
--         primer APPR) en POs y contratos → tiempos de aprobación por aprobador.
--   * B4  contracts.consumed_amount (captura manual de Compras mientras el
--         ERP no lo da) + external_link (PDF en SharePoint, lo cargan ellos).
--   * B5  sap_approval_requests: staging de la COLA DE AUTORIZACIÓN de SAP
--         (ApprovalRequests + borrador asociado), cuarto target del sync.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- A6 — SAP: campos de cancelación / autorización / cierre
-- -----------------------------------------------------------------------------
ALTER TABLE sap_purchase_orders
  ADD COLUMN cancelled            boolean,
  ADD COLUMN cancel_status        varchar(20),
  ADD COLUMN authorization_status varchar(30),
  ADD COLUMN confirmed            boolean,
  ADD COLUMN closing_date         timestamptz;

ALTER TABLE sap_purchase_requests
  ADD COLUMN cancelled            boolean,
  ADD COLUMN cancel_status        varchar(20),
  ADD COLUMN authorization_status varchar(30),
  ADD COLUMN confirmed            boolean,
  ADD COLUMN closing_date         timestamptz;

CREATE INDEX idx_sap_po_cancelled ON sap_purchase_orders (cancelled);
CREATE INDEX idx_sap_pr_cancelled ON sap_purchase_requests (cancelled);

COMMENT ON COLUMN sap_purchase_orders.cancelled IS
  'SAP B1 `Cancelled` (tYES/tNO). NULL = sincronizado antes de 0011 (re-sync full lo puebla). Estatus derivado: cancelled → Cancelada; si no, DocumentStatus.';
COMMENT ON COLUMN sap_purchase_orders.closing_date IS
  'SAP B1 `ClosingDate`. Base preferente para "días de gestión"; NULL = documento abierto o sin dato.';

-- -----------------------------------------------------------------------------
-- B3 — Maximo: fecha de espera de aprobación y aprobador
-- -----------------------------------------------------------------------------
ALTER TABLE maximo_purchase_orders
  ADD COLUMN waiting_approval_at timestamptz,
  ADD COLUMN approved_by         varchar(100);

ALTER TABLE maximo_contracts
  ADD COLUMN approved_by varchar(100);

COMMENT ON COLUMN maximo_purchase_orders.waiting_approval_at IS
  'Primer POSTATUS=WAPPR (CHANGEDATE). approved_at - waiting_approval_at = días de aprobación. Se rellena con `maximo:remap` (vive en raw).';
COMMENT ON COLUMN maximo_purchase_orders.approved_by IS
  'CHANGEBY del primer POSTATUS=APPR (usuario Maximo que aprobó).';

-- -----------------------------------------------------------------------------
-- B4 — Contratos: consumido (captura manual) y link externo (SharePoint)
-- -----------------------------------------------------------------------------
ALTER TABLE contracts
  ADD COLUMN consumed_amount numeric(14,2),
  ADD COLUMN external_link   text;

COMMENT ON COLUMN contracts.consumed_amount IS
  'Monto consumido capturado por Compras (el % automático depende del ERP y queda fuera de alcance). Saldo = total_amount - consumed_amount, calculado, nunca persistido.';
COMMENT ON COLUMN contracts.external_link IS
  'URL del expediente (SharePoint); la cargan Compras. NULL = sin link.';

-- -----------------------------------------------------------------------------
-- B5 — SAP: cola de autorización (ApprovalRequests), cuarto target del sync
-- -----------------------------------------------------------------------------
ALTER TYPE sap_sync_target ADD VALUE IF NOT EXISTS 'approval_requests';

CREATE TABLE sap_approval_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 integer NOT NULL,          -- ApprovalRequests.Code (clave)
  approval_template_id integer,                  -- ApprovalTemplatesID
  template_name        varchar(120),             -- ApprovalTemplates.Name (catálogo)
  object_type          varchar(30),              -- ObjectType ('22' OC, '1470000113' solicitud, ...)
  is_draft             boolean,                  -- IsDraft (Y/N): aún es borrador
  draft_entry          integer,                  -- DraftEntry → Drafts.DocEntry
  draft_type           varchar(30),
  object_entry         integer,                  -- ObjectEntry: documento final ya generado
  status               varchar(30),              -- arsPending | arsApproved | arsNotApproved | arsGenerated | ...
  remarks              text,
  current_stage        integer,                  -- CurrentStage → ApprovalStages.Code
  current_stage_name   varchar(120),
  originator_id        integer,                  -- OriginatorID → Users.InternalKey
  originator_name      varchar(255),
  creation_date        timestamptz,
  doc_num              integer,                  -- del borrador (best-effort)
  doc_date             timestamptz,
  doc_total            numeric(15,2),
  currency             varchar(10),
  card_name            varchar(255),             -- proveedor (OC)
  requester_name       varchar(255),             -- solicitante (solicitud de pedido)
  approvers            jsonb,                    -- [{stage_code, stage_name, user_id, user_name, status, update_date}]
  raw_hash             varchar(64) NOT NULL,
  raw                  jsonb NOT NULL,
  mapper_version       text NOT NULL,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_changed_at      timestamptz,
  last_sync_run_id     uuid,
  CONSTRAINT uq_sap_approval_request_code UNIQUE (code)
);

CREATE INDEX idx_sap_approval_status ON sap_approval_requests (status);
CREATE INDEX idx_sap_approval_creation ON sap_approval_requests (creation_date);

COMMENT ON TABLE sap_approval_requests IS
  'Staging de la cola de autorización de SAP B1 (ApprovalRequests + datos del borrador). SOLO LECTURA: aprobar se sigue haciendo en SAP.';

GRANT SELECT, INSERT, UPDATE ON sap_approval_requests TO abent3t_app;

COMMIT;
