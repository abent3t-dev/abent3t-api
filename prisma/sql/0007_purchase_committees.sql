-- ============================================================================
-- 0007_purchase_committees.sql — Fase §16: Comité de Compras
-- ============================================================================
-- Workflow de aprobación SECUENCIAL del comité semanal (PPT + firmas
-- electrónicas + tiempos). La cadena de aprobadores NO va hardcodeada: vive
-- en `committee_approval_levels` (regla 1 de la fase / §20.A.5) con
-- `confirmed=false` hasta que Ingrid confirme el mapeo — el motor lee esta
-- tabla, así el cambio Gilberto↔David (o Félix vía usuario específico) es un
-- UPDATE sin deploy. Sin FKs hacia maximo_* ni contracts (regla 2).
--
-- Nota: esta tabla data-driven REEMPLAZA a la `committee_approval_chain` del
-- borrador de §16 (aquella exigía profile_id NOT NULL = UUIDs reales en el
-- seed; ésta permite rol y/o usuario y se seedea sin datos personales).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
CREATE TYPE committee_status AS ENUM
  ('borrador', 'en_aprobacion', 'aprobado', 'rechazado', 'cancelado');
CREATE TYPE committee_action AS ENUM ('aprobado', 'rechazado');

-- §16 pide auditar el comité: primer valor de compras en audit_entity
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'committee';

-- ----------------------------------------------------------------------------
-- Comité (1 por sesión semanal)
-- ----------------------------------------------------------------------------
CREATE TABLE purchase_committees (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_number       text NOT NULL UNIQUE,     -- "COM-2026-W21" (año-semana ISO)
  committee_date         date NOT NULL,            -- jueves programado
  title                  text NOT NULL,
  description            text,

  status                 committee_status NOT NULL DEFAULT 'borrador',
  current_version        int NOT NULL DEFAULT 1,
  current_approver_level int,                      -- orden vigente en committee_approval_levels;
                                                   -- NULL en borrador/aprobado/rechazado/cancelado

  submitted_at           timestamptz,
  approved_at            timestamptz,
  total_elapsed_hours    numeric(10,2),

  created_by             uuid NOT NULL REFERENCES profiles(id),
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now(),
  is_active              boolean NOT NULL DEFAULT true
);

CREATE INDEX idx_committees_status ON purchase_committees (status);
CREATE INDEX idx_committees_date   ON purchase_committees (committee_date);
CREATE INDEX idx_committees_author ON purchase_committees (created_by);

-- ----------------------------------------------------------------------------
-- Versiones del PPT (cada rechazo + reenvío incrementa la versión)
-- ----------------------------------------------------------------------------
CREATE TABLE committee_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id    uuid NOT NULL REFERENCES purchase_committees(id),
  version         int NOT NULL,
  file_name       text,               -- si se subió archivo
  storage_key     text,               -- key en el bucket purchase-committees
  external_link   text,               -- alternativa: Google Slides/SharePoint (HTTPS)
  mime_type       text,
  file_size_bytes bigint,
  uploaded_by     uuid REFERENCES profiles(id),
  uploaded_at     timestamptz DEFAULT now(),
  CONSTRAINT uq_committee_version UNIQUE (committee_id, version),
  -- Debe traer archivo O link (el flujo de §16 exige documento por versión)
  CONSTRAINT chk_version_has_content
    CHECK (storage_key IS NOT NULL OR external_link IS NOT NULL)
);

CREATE INDEX idx_committee_versions_committee ON committee_versions (committee_id);

-- ----------------------------------------------------------------------------
-- Firmas electrónicas: 1 acción por (versión, nivel) — idempotencia por UNIQUE
-- ----------------------------------------------------------------------------
CREATE TABLE committee_approvals (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id                 uuid NOT NULL REFERENCES purchase_committees(id),
  version                      int NOT NULL,
  approver_level               int NOT NULL,
  approver_profile_id          uuid NOT NULL REFERENCES profiles(id),
  approver_role                user_role NOT NULL,
  action                       committee_action NOT NULL,
  justification                text,
  action_at                    timestamptz DEFAULT now(),
  elapsed_hours_since_assigned numeric(10,2),
  ip_address                   inet,
  user_agent                   text,
  CONSTRAINT uq_committee_approval UNIQUE (committee_id, version, approver_level),
  -- Rechazo SIEMPRE con justificación (además del @MinLength(10) del DTO)
  CONSTRAINT chk_reject_needs_justification
    CHECK (action <> 'rechazado' OR justification IS NOT NULL)
);

CREATE INDEX idx_committee_approvals_committee ON committee_approvals (committee_id);

-- ----------------------------------------------------------------------------
-- Cadena de aprobación DATA-DRIVEN (regla 1 / §20.A.5)
-- rol y/o usuario: si profile_id es NULL aprueba cualquier usuario activo con
-- ese rol; si está poblado, SOLO ese usuario (p. ej. Félix sin crear rol cfo).
-- ----------------------------------------------------------------------------
CREATE TABLE committee_approval_levels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  orden      int NOT NULL UNIQUE,           -- secuencia 1..N del flujo
  role       user_role NOT NULL,
  profile_id uuid REFERENCES profiles(id),  -- opcional (usuario específico)
  confirmed  boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  notes      text
);

-- Seed del mapeo propuesto en §17 (APPROVERS_COMITE). SIN UUIDs reales y con
-- confirmed=false: PENDIENTE confirmación de Ingrid (ver notas por fila).
INSERT INTO committee_approval_levels (orden, role, confirmed, notes) VALUES
  (1, 'lider_procura',     false, 'Ingrid (Líder de Procura). PENDIENTE Ingrid: ¿puede saltarse su propio paso?'),
  (2, 'aprobador_nivel_1', false, 'Gilberto según reunión 26-may; la sección 12 original decía David. PENDIENTE Ingrid: Gilberto vs David.'),
  (3, 'aprobador_nivel_2', false, 'Alejandro. PENDIENTE Ingrid: confirmar.'),
  (4, 'aprobador_nivel_3', false, 'Uriel. PENDIENTE Ingrid: confirmar.'),
  (5, 'director_general',  false, 'Félix. PENDIENTE Ingrid: ¿director_general o rol cfo? Si es cfo, poblar profile_id de Félix en vez de crear el rol.');

-- ----------------------------------------------------------------------------
-- Permisos del rol de la aplicación (sin DELETE: soft delete / historial)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON purchase_committees        TO abent3t_app;
GRANT SELECT, INSERT, UPDATE ON committee_versions         TO abent3t_app;
GRANT SELECT, INSERT, UPDATE ON committee_approvals        TO abent3t_app;
GRANT SELECT, INSERT, UPDATE ON committee_approval_levels  TO abent3t_app;
