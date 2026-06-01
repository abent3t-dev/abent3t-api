-- =============================================================================
-- 0001_baseline_schema.sql
-- ABENT 3T — Baseline schema para PostgreSQL 16 self-hosted (post-Supabase).
--
-- Generado por extracción del catálogo del proyecto Supabase remoto vía MCP,
-- el 2026-05-31. Aplica los cambios estructurales decididos en el Checkpoint 1:
--   * §A — profiles.id pasa a UUID autónomo (DEFAULT gen_random_uuid),
--          se elimina la FK profiles_id_fkey → auth.users (auth.users NO existe
--          en este servidor; identidad la maneja Entra ID / login-local).
--   * §A — Se agrega profiles.pending_first_login (K-7) para soportar el
--          modelo de pre-registro + activación al primer login OIDC.
--   * §B — local_credentials se crea en migración aparte (0002).
--   * §C — Ningún trigger (los updated_at se manejan con @updatedAt de Prisma;
--          los 3 triggers de negocio se portan a service: §K-4 del AUDIT).
--   * §D — Ninguna función Postgres (calculate_business_days se porta a TS
--          util: §K-2 del AUDIT).
--   * §E — Vista v_editions_with_effective_cost NO se replica (no se consume
--          desde código actualmente; ver §J.5 del AUDIT).
--   * §F — Sin RLS — la seguridad vive 100% en guards/services (regla de oro
--          del PDF v3.0; ver MIGRATION.md §1 y §G del AUDIT).
--
-- Ejecutar como superuser (postgres). Los GRANTs finales conceden permisos
-- mínimos al rol de aplicación (abent3t_app).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- provee gen_random_uuid()

-- -----------------------------------------------------------------------------
-- 2. Enums (22) — orden alfabético; valores 1:1 con la BD real de Supabase.
--    NO usar los enums de CLAUDE.md (tiene discrepancias). Ver §K-3 del AUDIT.
-- -----------------------------------------------------------------------------
CREATE TYPE approval_status AS ENUM ('pendiente', 'aprobada', 'rechazada');
CREATE TYPE approval_workflow_status AS ENUM ('pendiente', 'aprobada', 'rechazada');
CREATE TYPE audit_action AS ENUM ('create', 'update', 'delete', 'approve', 'reject', 'upload', 'verify');
CREATE TYPE audit_entity AS ENUM (
  'course', 'course_edition', 'enrollment', 'evidence', 'budget', 'request',
  'user', 'proposal', 'platform_integration', 'platform_course',
  'platform_enrollment', 'platform_sync', 'fiscal_loss',
  'fiscal_loss_amortization', 'non_deductible', 'shareholding', 'okr',
  'sap_config', 'sat_config', 'payment_reconciliation', 'cfdi'
);
CREATE TYPE cfdi_type AS ENUM ('I', 'E', 'P', 'N', 'T');
CREATE TYPE evidence_type AS ENUM ('certificate', 'attendance', 'assessment', 'other');
CREATE TYPE expense_type AS ENUM ('CAPEX', 'OPEX');
CREATE TYPE fiscal_loss_status AS ENUM ('vigente', 'proxima_a_vencer', 'vencida', 'amortizada_total');
CREATE TYPE okr_status AS ENUM ('on_track', 'at_risk', 'behind', 'completed');
CREATE TYPE okr_type AS ENUM ('objective', 'key_result');
CREATE TYPE payment_reconciliation_status AS ENUM ('conciliado', 'diferencia_monto', 'solo_en_sap', 'solo_en_sat');
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'cancelled', 'na');
CREATE TYPE platform_enrollment_status AS ENUM ('not_started', 'in_progress', 'completed', 'expired');
CREATE TYPE platform_type AS ENUM ('crehana', 'udemy_business', 'linkedin_learning', 'coursera', 'other');
CREATE TYPE po_status AS ENUM ('emitida', 'en_transito', 'entregada_parcial', 'entregada_completa', 'cancelada');
CREATE TYPE proposal_status AS ENUM ('pendiente', 'en_investigacion', 'aprobada', 'rechazada');
CREATE TYPE request_status AS ENUM ('pendiente', 'aprobada', 'rechazada');
CREATE TYPE requisition_status AS ENUM ('en_revision', 'en_aprobacion', 'aprobada', 'en_progreso', 'cerrada', 'cancelada');
CREATE TYPE sync_status AS ENUM ('pending', 'in_progress', 'completed', 'failed');
CREATE TYPE user_module AS ENUM ('core', 'capacitacion', 'compras', 'contabilidad');
CREATE TYPE user_role AS ENUM (
  'admin_rh', 'director', 'collaborator', 'executive', 'super_admin', 'jefe_area',
  'colaborador', 'comprador', 'coordinador_compras', 'lider_procura',
  'aprobador_nivel_1', 'aprobador_nivel_2', 'aprobador_nivel_3', 'director_general',
  'solicitante', 'contabilidad', 'fiscal', 'director_financiero', 'accionista'
);
CREATE TYPE verification_status AS ENUM ('pending', 'approved', 'rejected');

-- =============================================================================
-- 3. Tables
--    PKs y NOT NULL/DEFAULT inline. Las FKs van al final (sección 4) para no
--    depender del orden. Los UNIQUE/CHECK que coexisten con la columna van
--    inline; los compuestos van como CONSTRAINT separados.
-- =============================================================================

-- ----- Catálogos independientes ---------------------------------------------

CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(255) NOT NULL UNIQUE,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE institutions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          varchar(255) NOT NULL UNIQUE,
  type          varchar(20)  NOT NULL DEFAULT 'external',
  is_platform   boolean NOT NULL DEFAULT false,
  annual_cost   numeric(12,2) DEFAULT 0,
  platform_url  varchar(500),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institutions_type_check CHECK (type IN ('external', 'platform', 'internal'))
);

CREATE TABLE course_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(100) NOT NULL UNIQUE,
  key         varchar(50)  NOT NULL UNIQUE,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE modalities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(100) NOT NULL UNIQUE,
  key         varchar(50)  NOT NULL UNIQUE,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year        integer NOT NULL,
  semester    integer,
  label       varchar(50) NOT NULL,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT periods_semester_check CHECK (semester IN (1, 2)),
  CONSTRAINT periods_year_semester_key UNIQUE (year, semester)
);

CREATE TABLE purchase_types (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              varchar(100) NOT NULL UNIQUE,
  key               varchar(50)  NOT NULL UNIQUE,
  requires_contract boolean DEFAULT false,
  description       text,
  is_active         boolean DEFAULT true,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE TABLE holidays (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date  date NOT NULL UNIQUE,
  description   varchar(255) NOT NULL,
  is_active     boolean DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE TABLE inpc_factors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year        integer NOT NULL,
  month       integer NOT NULL,
  factor      numeric(10,6) NOT NULL,
  is_active   boolean DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  CONSTRAINT inpc_factors_month_check CHECK (month BETWEEN 1 AND 12),
  CONSTRAINT inpc_factors_year_month_key UNIQUE (year, month)
);

CREATE TABLE sap_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment         varchar(50) NOT NULL DEFAULT 'production',
  base_url            text NOT NULL,
  company_db          varchar(100) NOT NULL,
  username            varchar(100) NOT NULL,
  encrypted_password  text NOT NULL,
  is_active           boolean DEFAULT true,
  last_sync_at        timestamptz,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE sat_credentials (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfc                   varchar(13) NOT NULL UNIQUE,
  encrypted_ciec        text,
  encrypted_efirma_cer  text,
  encrypted_efirma_key  text,
  efirma_password_hint  varchar(100),
  is_active             boolean DEFAULT true,
  validated_at          timestamptz,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

CREATE TABLE sat_declarations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_declaracion    varchar(50) NOT NULL,
  ejercicio           integer NOT NULL,
  periodo             varchar(20) NOT NULL,
  fecha_presentacion  timestamptz NOT NULL,
  fecha_limite        timestamptz,
  acuse_url           text,
  monto_a_cargo       numeric(18,2) DEFAULT 0,
  monto_a_favor       numeric(18,2) DEFAULT 0,
  monto_pagado        numeric(18,2) DEFAULT 0,
  status              varchar(50) DEFAULT 'presentada',
  is_active           boolean DEFAULT true,
  created_at          timestamptz DEFAULT now()
);

CREATE TABLE cfdis (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uuid                    varchar(36) NOT NULL UNIQUE,
  tipo                    cfdi_type NOT NULL,
  rfc_emisor              varchar(13) NOT NULL,
  nombre_emisor           varchar(250),
  rfc_receptor            varchar(13) NOT NULL,
  nombre_receptor         varchar(250),
  fecha_emision           timestamptz NOT NULL,
  fecha_certificacion     timestamptz,
  subtotal                numeric(18,2) DEFAULT 0,
  descuento               numeric(18,2) DEFAULT 0,
  total                   numeric(18,2) NOT NULL,
  moneda                  varchar(3)  DEFAULT 'MXN',
  tipo_cambio             numeric(18,6) DEFAULT 1,
  forma_pago              varchar(50),
  metodo_pago             varchar(10),
  uso_cfdi                varchar(10),
  version_complementaria  boolean DEFAULT false,
  uuid_relacionado        varchar(36),
  xml_content             text,
  status                  varchar(50) DEFAULT 'vigente',
  downloaded_at           timestamptz DEFAULT now(),
  is_active               boolean DEFAULT true,
  created_at              timestamptz DEFAULT now()
);

CREATE TABLE sync_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source            varchar(20) NOT NULL,
  sync_type         varchar(50) NOT NULL,
  status            sync_status DEFAULT 'pending',
  records_fetched   integer DEFAULT 0,
  error_message     text,
  started_at        timestamptz DEFAULT now(),
  finished_at       timestamptz,
  created_at        timestamptz DEFAULT now(),
  CONSTRAINT sync_logs_source_check CHECK (source IN ('sap', 'sat'))
);

-- ----- Identidad (profiles + user_roles) -------------------------------------
--
-- CAMBIO ESTRUCTURAL MIGRATION.md §2.2-3:
--   * profiles.id pasa a UUID con DEFAULT gen_random_uuid() (autónomo).
--   * Se elimina la FK profiles_id_fkey → auth.users (auth.users no existe).
--   * profiles.role permanece NOT NULL DEFAULT 'collaborator' como columna
--     "huérfana" (CLAUDE.md §1; ver §K-9 del AUDIT). Se mantiene para no
--     romper inserts existentes; user_roles es la fuente de verdad.
-- CAMBIO NUEVO (K-7):
--   * Se agrega profiles.pending_first_login para el modelo de pre-registro
--     + activación al primer login OIDC. Por default true; el callback OIDC
--     o el login-local lo pone en false al activar.
--
CREATE TABLE profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name             varchar(255),
  email                 varchar(255) NOT NULL UNIQUE,
  department_id         uuid,
  role                  user_role NOT NULL DEFAULT 'collaborator',
  position              varchar(255),
  pending_first_login   boolean NOT NULL DEFAULT true,  -- K-7
  is_active             boolean NOT NULL DEFAULT true,
  deactivated_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL,
  module      user_module NOT NULL,
  role        user_role NOT NULL,
  granted_at  timestamptz DEFAULT now(),
  granted_by  uuid,
  revoked_at  timestamptz,
  revoked_by  uuid,
  is_active   boolean DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  CONSTRAINT user_roles_unique UNIQUE (profile_id, module, role)
);

-- ----- Auditoría --------------------------------------------------------------

CREATE TABLE audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action      audit_action NOT NULL,
  entity_type audit_entity NOT NULL,
  entity_id   uuid NOT NULL,
  entity_name varchar(255),
  user_id     uuid NOT NULL,
  user_name   varchar(255),
  user_role   varchar(50),
  old_values  jsonb,
  new_values  jsonb,
  description text,
  ip_address  varchar(45),
  user_agent  text,
  created_at  timestamp DEFAULT now()
);

-- ----- Capacitación ----------------------------------------------------------

CREATE TABLE courses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            varchar(255) NOT NULL,
  institution_id  uuid,
  course_type_id  uuid,
  modality_id     uuid,
  total_hours     integer NOT NULL DEFAULT 0,
  cost            numeric(12,2) NOT NULL DEFAULT 0,
  description     text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE course_editions (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id                       uuid NOT NULL,
  start_date                      date NOT NULL,
  end_date                        date,
  location                        varchar(255),
  instructor                      varchar(255),
  max_participants                integer,
  is_active                       boolean NOT NULL DEFAULT true,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  prorate_cost                    boolean DEFAULT false,
  require_evidence_for_completion boolean DEFAULT true,
  cost_override                   numeric,
  payment_status                  text DEFAULT 'pending',
  payment_reference               varchar(255),
  payment_date                    date,
  CONSTRAINT course_editions_payment_status_check
    CHECK (payment_status IN ('pending', 'paid', 'cancelled', 'na'))
);

CREATE TABLE budgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id   uuid NOT NULL,
  period_id       uuid NOT NULL,
  assigned_amount numeric NOT NULL DEFAULT 0,
  consumed_amount numeric NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE course_enrollments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_edition_id uuid NOT NULL,
  profile_id        uuid NOT NULL,
  status            text NOT NULL DEFAULT 'inscrito',
  enrolled_at       timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_enrollments_status_check
    CHECK (status IN ('inscrito', 'en_curso', 'completo', 'pendiente_evidencia', 'cancelado')),
  CONSTRAINT course_enrollments_unique UNIQUE (course_edition_id, profile_id)
);

CREATE TABLE enrollment_evidences (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id       uuid NOT NULL,
  file_name           varchar(255) NOT NULL,
  file_path           text NOT NULL,
  file_size           integer NOT NULL,
  file_type           varchar(100) NOT NULL,
  evidence_type       evidence_type NOT NULL DEFAULT 'certificate',
  uploaded_by         uuid NOT NULL,
  uploaded_at         timestamptz DEFAULT now(),
  verification_status verification_status NOT NULL DEFAULT 'pending',
  verified_by         uuid,
  verified_at         timestamptz,
  rejection_reason    text,
  notes               text,
  is_active           boolean DEFAULT true,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE training_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_edition_id uuid NOT NULL,
  profile_id        uuid NOT NULL,
  requested_by      uuid NOT NULL,
  status            request_status DEFAULT 'pendiente',
  request_reason    text,
  reviewed_by       uuid,
  reviewed_at       timestamp,
  rejection_reason  text,
  enrollment_id     uuid,
  is_active         boolean DEFAULT true,
  created_at        timestamp DEFAULT now(),
  updated_at        timestamp DEFAULT now(),
  CONSTRAINT training_requests_course_edition_id_profile_id_is_active_key
    UNIQUE (course_edition_id, profile_id, is_active)
);

CREATE TABLE course_proposals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_by       uuid NOT NULL,
  profile_id        uuid NOT NULL,
  course_name       varchar(255) NOT NULL,
  institution_name  varchar(255),
  course_url        text,
  estimated_cost    numeric DEFAULT 0,
  estimated_hours   integer DEFAULT 0,
  modality          varchar(50),
  start_date        date,
  end_date          date,
  justification     text,
  status            proposal_status DEFAULT 'pendiente',
  reviewed_by       uuid,
  reviewed_at       timestamp,
  review_notes      text,
  rejection_reason  text,
  course_id         uuid,
  course_edition_id uuid,
  enrollment_id     uuid,
  is_active         boolean DEFAULT true,
  created_at        timestamp DEFAULT now(),
  updated_at        timestamp DEFAULT now()
);

CREATE TABLE proposal_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id   uuid NOT NULL,
  file_name     varchar(255) NOT NULL,
  file_path     text NOT NULL,
  file_size     integer NOT NULL,
  file_type     varchar(100) NOT NULL,
  uploaded_by   uuid NOT NULL,
  uploaded_at   timestamptz DEFAULT now(),
  is_active     boolean DEFAULT true,
  created_at    timestamptz DEFAULT now()
);

-- ----- Compras ---------------------------------------------------------------

CREATE TABLE suppliers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name          varchar(255) NOT NULL,
  commercial_name     varchar(255),
  tax_id              varchar(20) NOT NULL UNIQUE,
  email               varchar(255),
  phone               varchar(50),
  address             text,
  contact_name        varchar(255),
  contact_email       varchar(255),
  contact_phone       varchar(50),
  performance_score   numeric(5,2) DEFAULT 0,
  is_blocked          boolean DEFAULT false,
  blocked_reason      text,
  blocked_at          timestamptz,
  blocked_by          uuid,
  is_active           boolean DEFAULT true,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  CONSTRAINT suppliers_performance_score_check CHECK (performance_score BETWEEN 0 AND 100)
);

CREATE TABLE requisitions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rq_number               varchar(50) NOT NULL UNIQUE,
  description             text NOT NULL,
  justification           text,
  requester_id            uuid NOT NULL,
  department_id           uuid,
  buyer_id                uuid,
  status                  requisition_status DEFAULT 'en_revision',
  expense_type            expense_type DEFAULT 'OPEX',
  source                  varchar(20) DEFAULT 'manual',
  external_id             varchar(100),
  estimated_amount        numeric(15,2) DEFAULT 0,
  created_date            date NOT NULL DEFAULT CURRENT_DATE,
  required_date           date,
  closed_date             date,
  business_days_elapsed   integer DEFAULT 0,
  is_active               boolean DEFAULT true,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now(),
  CONSTRAINT requisitions_source_check CHECK (source IN ('manual', 'maximo', 'sap'))
);

CREATE TABLE purchase_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number               varchar(50) NOT NULL UNIQUE,
  requisition_id          uuid NOT NULL,
  supplier_id             uuid NOT NULL,
  purchase_type_id        uuid NOT NULL,
  buyer_id                uuid NOT NULL,
  amount                  numeric(15,2) NOT NULL,
  expense_type            expense_type DEFAULT 'OPEX',
  description             text,
  notes                   text,
  expected_delivery_date  date,
  actual_delivery_date    date,
  status                  po_status DEFAULT 'emitida',
  is_active               boolean DEFAULT true,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

CREATE TABLE approval_workflows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id  uuid NOT NULL UNIQUE,  -- approval_workflows_requisition_key
  current_level   integer DEFAULT 1,
  status          approval_workflow_status DEFAULT 'pendiente',
  started_at      timestamptz DEFAULT now(),
  completed_at    timestamptz,
  is_active       boolean DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE TABLE approvals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id       uuid NOT NULL,
  level             integer NOT NULL,
  approver_id       uuid NOT NULL,
  status            approval_status DEFAULT 'pendiente',
  comments          text,
  approved_at       timestamptz,
  rejected_at       timestamptz,
  rejection_reason  text,
  time_to_approve   integer,
  notified_at       timestamptz,
  is_active         boolean DEFAULT true,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  CONSTRAINT approvals_level_check CHECK (level BETWEEN 1 AND 4),
  CONSTRAINT approvals_workflow_level_key UNIQUE (workflow_id, level)
);

CREATE TABLE requisition_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id  uuid NOT NULL,
  field_changed   varchar(100) NOT NULL,
  old_value       text,
  new_value       text,
  changed_by      uuid NOT NULL,
  changed_at      timestamptz DEFAULT now()
);

-- ----- Plataformas externas (Crehana, etc.) ----------------------------------

CREATE TABLE platform_integrations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id          uuid NOT NULL UNIQUE,  -- platform_integrations_institution_unique
  platform_type           platform_type NOT NULL DEFAULT 'crehana',
  api_url                 varchar(500),
  public_key              varchar(500),
  private_key_encrypted   text,
  sync_enabled            boolean DEFAULT true,
  sync_frequency_hours    integer DEFAULT 24,
  last_sync_at            timestamptz,
  last_sync_status        sync_status DEFAULT 'pending',
  last_sync_error         text,
  sso_enabled             boolean DEFAULT false,
  sso_type                varchar(50),
  sso_config              jsonb,
  configured_by           uuid,
  is_active               boolean DEFAULT true,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now(),
  organization_slug       varchar(255)
);

CREATE TABLE platform_courses (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_integration_id uuid NOT NULL,
  external_course_id      varchar(255) NOT NULL,
  external_track_id       varchar(255),
  name                    varchar(500) NOT NULL,
  description             text,
  instructor              varchar(255),
  language                varchar(10) DEFAULT 'es',
  total_hours             numeric DEFAULT 0,
  total_modules           integer DEFAULT 0,
  total_lessons           integer DEFAULT 0,
  course_type_id          uuid,
  modality_id             uuid,
  course_url              text,
  thumbnail_url           text,
  is_active               boolean DEFAULT true,
  last_synced_at          timestamptz DEFAULT now(),
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now(),
  CONSTRAINT platform_courses_external_unique UNIQUE (platform_integration_id, external_course_id)
);

CREATE TABLE platform_user_mappings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_integration_id uuid NOT NULL,
  profile_id              uuid,
  external_user_id        varchar(255) NOT NULL,
  external_email          varchar(255),
  external_username       varchar(255),
  is_active               boolean DEFAULT true,
  last_synced_at          timestamptz DEFAULT now(),
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now(),
  CONSTRAINT platform_user_mappings_external_unique UNIQUE (platform_integration_id, external_user_id)
);

CREATE TABLE platform_enrollments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_course_id      uuid NOT NULL,
  profile_id              uuid,
  external_enrollment_id  varchar(255),
  external_user_id        varchar(255) NOT NULL,
  external_user_email     varchar(255),
  progress_percentage     numeric DEFAULT 0,
  status                  platform_enrollment_status DEFAULT 'not_started',
  enrolled_at             timestamptz,
  started_at              timestamptz,
  completed_at            timestamptz,
  last_activity_at        timestamptz,
  hours_completed         numeric DEFAULT 0,
  modules_completed       integer DEFAULT 0,
  lessons_completed       integer DEFAULT 0,
  certificate_url         text,
  certificate_issued_at   timestamptz,
  last_synced_at          timestamptz DEFAULT now(),
  sync_error              text,
  is_active               boolean DEFAULT true,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now(),
  CONSTRAINT platform_enrollments_progress_percentage_check
    CHECK (progress_percentage BETWEEN 0 AND 100),
  CONSTRAINT platform_enrollments_external_unique
    UNIQUE (platform_course_id, external_user_id)
);

CREATE TABLE platform_sync_logs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_integration_id uuid NOT NULL,
  sync_type               varchar(50) NOT NULL,
  status                  sync_status NOT NULL,
  started_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz,
  courses_synced          integer DEFAULT 0,
  enrollments_synced      integer DEFAULT 0,
  users_synced            integer DEFAULT 0,
  errors_count            integer DEFAULT 0,
  error_details           jsonb,
  sync_summary            jsonb,
  triggered_by            uuid,
  created_at              timestamptz DEFAULT now(),
  CONSTRAINT platform_sync_logs_sync_type_check
    CHECK (sync_type IN ('full', 'incremental', 'users', 'courses', 'progress'))
);

-- ----- Contabilidad ----------------------------------------------------------

CREATE TABLE accounting_okrs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo          varchar(255) NOT NULL,
  descripcion     text,
  periodo         varchar(20) NOT NULL,
  tipo            okr_type NOT NULL,
  parent_okr_id   uuid,
  target_value    numeric(18,2),
  current_value   numeric(18,2) DEFAULT 0,
  unit            varchar(50),
  status          okr_status DEFAULT 'on_track',
  due_date        date,
  created_by      uuid,
  is_active       boolean DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE TABLE fiscal_losses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ejercicio           integer NOT NULL,
  fecha_declaracion   date NOT NULL,
  fecha_vencimiento   date NOT NULL,
  monto_original      numeric(18,2) NOT NULL,
  factor_actualizacion numeric(10,6) DEFAULT 1,
  monto_actualizado   numeric(18,2) NOT NULL,
  amortizado          numeric(18,2) DEFAULT 0,
  saldo_pendiente     numeric(18,2) NOT NULL,
  status              fiscal_loss_status DEFAULT 'vigente',
  notes               text,
  created_by          uuid,
  is_active           boolean DEFAULT true,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE fiscal_loss_amortizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_loss_id        uuid NOT NULL,
  ejercicio_aplicacion  integer NOT NULL,
  monto_amortizado      numeric(18,2) NOT NULL,
  declaracion_id        uuid,
  notes                 text,
  created_by            uuid,
  is_active             boolean DEFAULT true,
  created_at            timestamptz DEFAULT now()
);

CREATE TABLE non_deductibles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  periodo         varchar(7) NOT NULL,
  concepto        varchar(255) NOT NULL,
  monto           numeric(18,2) NOT NULL,
  department_id   uuid,
  cfdi_uuid       varchar(36),
  notes           text,
  created_by      uuid,
  is_active       boolean DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE TABLE payment_complement_reconciliation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  periodo             varchar(7) NOT NULL,
  sap_payment_id      varchar(100),
  cfdi_uuid           varchar(36),
  rfc_proveedor       varchar(13),
  proveedor_nombre    varchar(255),
  monto_sap           numeric(18,2),
  monto_sat           numeric(18,2),
  difference_amount   numeric(18,2) DEFAULT 0,
  status              payment_reconciliation_status NOT NULL,
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  notes               text,
  is_active           boolean DEFAULT true,
  created_at          timestamptz DEFAULT now()
);

CREATE TABLE shareholding_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version             integer NOT NULL,
  effective_date      date NOT NULL,
  event_description   text,
  created_by          uuid,
  is_active           boolean DEFAULT true,
  created_at          timestamptz DEFAULT now()
);

CREATE TABLE shareholding_detail (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shareholding_record_id  uuid NOT NULL,
  accionista_nombre       varchar(255) NOT NULL,
  rfc                     varchar(13),
  tipo_accion             varchar(50) DEFAULT 'ordinaria',
  porcentaje              numeric(6,3) NOT NULL,
  num_acciones            integer,
  notes                   text,
  is_active               boolean DEFAULT true,
  created_at              timestamptz DEFAULT now(),
  CONSTRAINT shareholding_detail_porcentaje_check CHECK (porcentaje BETWEEN 0 AND 100)
);

-- =============================================================================
-- 4. Foreign Keys (ALTER TABLE — orden independiente)
-- =============================================================================

-- profiles: NOTA — NO se crea FK a auth.users (auth.users no existe en este
-- servidor; identidad gestionada por Entra ID / login-local).
ALTER TABLE profiles
  ADD CONSTRAINT profiles_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id);

ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
  ADD CONSTRAINT user_roles_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES profiles(id),
  ADD CONSTRAINT user_roles_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES profiles(id);

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id);

ALTER TABLE courses
  ADD CONSTRAINT courses_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES institutions(id),
  ADD CONSTRAINT courses_course_type_id_fkey FOREIGN KEY (course_type_id) REFERENCES course_types(id),
  ADD CONSTRAINT courses_modality_id_fkey FOREIGN KEY (modality_id) REFERENCES modalities(id);

ALTER TABLE course_editions
  ADD CONSTRAINT course_editions_course_id_fkey FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE;

ALTER TABLE budgets
  ADD CONSTRAINT budgets_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id),
  ADD CONSTRAINT budgets_period_id_fkey FOREIGN KEY (period_id) REFERENCES periods(id);

ALTER TABLE course_enrollments
  ADD CONSTRAINT course_enrollments_edition_fkey FOREIGN KEY (course_edition_id) REFERENCES course_editions(id) ON DELETE CASCADE,
  ADD CONSTRAINT course_enrollments_profile_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE enrollment_evidences
  ADD CONSTRAINT enrollment_evidences_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES course_enrollments(id) ON DELETE CASCADE,
  ADD CONSTRAINT enrollment_evidences_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id),
  ADD CONSTRAINT enrollment_evidences_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES profiles(id);

ALTER TABLE training_requests
  ADD CONSTRAINT training_requests_course_edition_id_fkey FOREIGN KEY (course_edition_id) REFERENCES course_editions(id),
  ADD CONSTRAINT training_requests_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id),
  ADD CONSTRAINT training_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES profiles(id),
  ADD CONSTRAINT training_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES profiles(id),
  ADD CONSTRAINT training_requests_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES course_enrollments(id);

ALTER TABLE course_proposals
  ADD CONSTRAINT course_proposals_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES profiles(id),
  ADD CONSTRAINT course_proposals_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id),
  ADD CONSTRAINT course_proposals_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES profiles(id),
  ADD CONSTRAINT course_proposals_course_id_fkey FOREIGN KEY (course_id) REFERENCES courses(id),
  ADD CONSTRAINT course_proposals_course_edition_id_fkey FOREIGN KEY (course_edition_id) REFERENCES course_editions(id),
  ADD CONSTRAINT course_proposals_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES course_enrollments(id);

ALTER TABLE proposal_attachments
  ADD CONSTRAINT proposal_attachments_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES course_proposals(id) ON DELETE CASCADE,
  ADD CONSTRAINT proposal_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id);

ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_blocked_by_fkey FOREIGN KEY (blocked_by) REFERENCES profiles(id);

ALTER TABLE requisitions
  ADD CONSTRAINT requisitions_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES profiles(id),
  ADD CONSTRAINT requisitions_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id),
  ADD CONSTRAINT requisitions_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES profiles(id);

ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES requisitions(id),
  ADD CONSTRAINT purchase_orders_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  ADD CONSTRAINT purchase_orders_purchase_type_id_fkey FOREIGN KEY (purchase_type_id) REFERENCES purchase_types(id),
  ADD CONSTRAINT purchase_orders_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES profiles(id);

ALTER TABLE approval_workflows
  ADD CONSTRAINT approval_workflows_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES requisitions(id) ON DELETE CASCADE;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES approval_workflows(id) ON DELETE CASCADE,
  ADD CONSTRAINT approvals_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES profiles(id);

ALTER TABLE requisition_history
  ADD CONSTRAINT requisition_history_requisition_id_fkey FOREIGN KEY (requisition_id) REFERENCES requisitions(id) ON DELETE CASCADE,
  ADD CONSTRAINT requisition_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES profiles(id);

ALTER TABLE platform_integrations
  ADD CONSTRAINT platform_integrations_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES institutions(id),
  ADD CONSTRAINT platform_integrations_configured_by_fkey FOREIGN KEY (configured_by) REFERENCES profiles(id);

ALTER TABLE platform_courses
  ADD CONSTRAINT platform_courses_platform_integration_id_fkey FOREIGN KEY (platform_integration_id) REFERENCES platform_integrations(id),
  ADD CONSTRAINT platform_courses_course_type_id_fkey FOREIGN KEY (course_type_id) REFERENCES course_types(id),
  ADD CONSTRAINT platform_courses_modality_id_fkey FOREIGN KEY (modality_id) REFERENCES modalities(id);

ALTER TABLE platform_user_mappings
  ADD CONSTRAINT platform_user_mappings_platform_integration_id_fkey FOREIGN KEY (platform_integration_id) REFERENCES platform_integrations(id),
  ADD CONSTRAINT platform_user_mappings_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id);

ALTER TABLE platform_enrollments
  ADD CONSTRAINT platform_enrollments_platform_course_id_fkey FOREIGN KEY (platform_course_id) REFERENCES platform_courses(id),
  ADD CONSTRAINT platform_enrollments_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id);

ALTER TABLE platform_sync_logs
  ADD CONSTRAINT platform_sync_logs_platform_integration_id_fkey FOREIGN KEY (platform_integration_id) REFERENCES platform_integrations(id),
  ADD CONSTRAINT platform_sync_logs_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES profiles(id);

ALTER TABLE accounting_okrs
  ADD CONSTRAINT accounting_okrs_parent_okr_id_fkey FOREIGN KEY (parent_okr_id) REFERENCES accounting_okrs(id),
  ADD CONSTRAINT accounting_okrs_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE fiscal_losses
  ADD CONSTRAINT fiscal_losses_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE fiscal_loss_amortizations
  ADD CONSTRAINT fiscal_loss_amortizations_fiscal_loss_id_fkey FOREIGN KEY (fiscal_loss_id) REFERENCES fiscal_losses(id) ON DELETE CASCADE,
  ADD CONSTRAINT fiscal_loss_amortizations_declaracion_id_fkey FOREIGN KEY (declaracion_id) REFERENCES sat_declarations(id),
  ADD CONSTRAINT fiscal_loss_amortizations_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE non_deductibles
  ADD CONSTRAINT non_deductibles_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id),
  ADD CONSTRAINT non_deductibles_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE payment_complement_reconciliation
  ADD CONSTRAINT payment_complement_reconciliation_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES profiles(id);

ALTER TABLE shareholding_records
  ADD CONSTRAINT shareholding_records_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);

ALTER TABLE shareholding_detail
  ADD CONSTRAINT shareholding_detail_shareholding_record_id_fkey FOREIGN KEY (shareholding_record_id) REFERENCES shareholding_records(id) ON DELETE CASCADE;

-- =============================================================================
-- 5. Indexes (no-primarios, no-únicos-redundantes)
--    Las UNIQUE definidas como CONSTRAINT ya generan su índice; aquí solo van
--    los índices adicionales para query performance.
-- =============================================================================

-- accounting_okrs
CREATE INDEX idx_accounting_okrs_active   ON accounting_okrs (is_active) WHERE is_active = true;
CREATE INDEX idx_accounting_okrs_parent   ON accounting_okrs (parent_okr_id);
CREATE INDEX idx_accounting_okrs_periodo  ON accounting_okrs (periodo);
CREATE INDEX idx_accounting_okrs_status   ON accounting_okrs (status);
CREATE INDEX idx_accounting_okrs_tipo     ON accounting_okrs (tipo);

-- approval_workflows
CREATE INDEX idx_approval_workflows_active        ON approval_workflows (is_active) WHERE is_active = true;
CREATE INDEX idx_approval_workflows_current_level ON approval_workflows (current_level)
  WHERE is_active = true AND status = 'pendiente'::approval_workflow_status;
CREATE INDEX idx_approval_workflows_status        ON approval_workflows (status) WHERE is_active = true;

-- approvals
CREATE INDEX idx_approvals_active   ON approvals (is_active) WHERE is_active = true;
CREATE INDEX idx_approvals_approver ON approvals (approver_id) WHERE is_active = true;
CREATE INDEX idx_approvals_pending  ON approvals (approver_id, status)
  WHERE is_active = true AND status = 'pendiente'::approval_status;
CREATE INDEX idx_approvals_status   ON approvals (status) WHERE is_active = true;
CREATE INDEX idx_approvals_workflow ON approvals (workflow_id);

-- audit_logs
CREATE INDEX idx_audit_logs_action     ON audit_logs (action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_logs_entity     ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_logs_user_id    ON audit_logs (user_id);

-- budgets
CREATE UNIQUE INDEX budgets_department_period_unique ON budgets (department_id, period_id) WHERE is_active = true;
CREATE INDEX idx_budgets_department_id ON budgets (department_id);
CREATE INDEX idx_budgets_period_id     ON budgets (period_id);

-- cfdis
CREATE INDEX idx_cfdis_active        ON cfdis (is_active) WHERE is_active = true;
CREATE INDEX idx_cfdis_fecha_emision ON cfdis (fecha_emision);
CREATE INDEX idx_cfdis_rfc_emisor    ON cfdis (rfc_emisor);
CREATE INDEX idx_cfdis_rfc_receptor  ON cfdis (rfc_receptor);
CREATE INDEX idx_cfdis_tipo          ON cfdis (tipo);
CREATE INDEX idx_cfdis_uuid          ON cfdis (uuid);

-- course_editions
CREATE INDEX idx_course_editions_course         ON course_editions (course_id);
CREATE INDEX idx_course_editions_payment_status ON course_editions (payment_status) WHERE is_active = true;

-- course_enrollments
CREATE INDEX idx_enrollments_edition ON course_enrollments (course_edition_id);
CREATE INDEX idx_enrollments_profile ON course_enrollments (profile_id);
CREATE INDEX idx_enrollments_status  ON course_enrollments (status);

-- course_proposals
CREATE INDEX idx_course_proposals_profile     ON course_proposals (profile_id) WHERE is_active = true;
CREATE INDEX idx_course_proposals_proposed_by ON course_proposals (proposed_by) WHERE is_active = true;
CREATE INDEX idx_course_proposals_status      ON course_proposals (status) WHERE is_active = true;

-- courses
CREATE INDEX idx_courses_institution ON courses (institution_id);
CREATE INDEX idx_courses_modality    ON courses (modality_id);
CREATE INDEX idx_courses_type        ON courses (course_type_id);

-- enrollment_evidences
CREATE INDEX idx_evidences_enrollment   ON enrollment_evidences (enrollment_id);
CREATE INDEX idx_evidences_status       ON enrollment_evidences (verification_status) WHERE is_active = true;
CREATE INDEX idx_evidences_uploaded_by  ON enrollment_evidences (uploaded_by);

-- fiscal_loss_amortizations
CREATE INDEX idx_fiscal_loss_amortizations_ejercicio    ON fiscal_loss_amortizations (ejercicio_aplicacion);
CREATE INDEX idx_fiscal_loss_amortizations_fiscal_loss  ON fiscal_loss_amortizations (fiscal_loss_id);

-- fiscal_losses
CREATE INDEX idx_fiscal_losses_active             ON fiscal_losses (is_active) WHERE is_active = true;
CREATE INDEX idx_fiscal_losses_ejercicio          ON fiscal_losses (ejercicio);
CREATE INDEX idx_fiscal_losses_fecha_vencimiento  ON fiscal_losses (fecha_vencimiento);
CREATE INDEX idx_fiscal_losses_status             ON fiscal_losses (status);

-- holidays
CREATE INDEX idx_holidays_date ON holidays (holiday_date) WHERE is_active = true;
CREATE INDEX idx_holidays_year ON holidays (EXTRACT(year FROM holiday_date)) WHERE is_active = true;

-- inpc_factors
CREATE INDEX idx_inpc_factors_year_month ON inpc_factors (year, month);

-- non_deductibles
CREATE INDEX idx_non_deductibles_active     ON non_deductibles (is_active) WHERE is_active = true;
CREATE INDEX idx_non_deductibles_department ON non_deductibles (department_id);
CREATE INDEX idx_non_deductibles_periodo    ON non_deductibles (periodo);

-- payment_complement_reconciliation
CREATE INDEX idx_payment_reconciliation_active  ON payment_complement_reconciliation (is_active) WHERE is_active = true;
CREATE INDEX idx_payment_reconciliation_periodo ON payment_complement_reconciliation (periodo);
CREATE INDEX idx_payment_reconciliation_status  ON payment_complement_reconciliation (status);

-- platform_courses
CREATE INDEX idx_platform_courses_external    ON platform_courses (external_course_id);
CREATE INDEX idx_platform_courses_integration ON platform_courses (platform_integration_id);
CREATE INDEX idx_platform_courses_name        ON platform_courses (name);

-- platform_enrollments
CREATE INDEX idx_platform_enrollments_course   ON platform_enrollments (platform_course_id);
CREATE INDEX idx_platform_enrollments_email    ON platform_enrollments (external_user_email);
CREATE INDEX idx_platform_enrollments_profile  ON platform_enrollments (profile_id);
CREATE INDEX idx_platform_enrollments_progress ON platform_enrollments (progress_percentage);
CREATE INDEX idx_platform_enrollments_status   ON platform_enrollments (status);

-- platform_integrations
CREATE INDEX idx_platform_integrations_sync ON platform_integrations (sync_enabled) WHERE sync_enabled = true;
CREATE INDEX idx_platform_integrations_type ON platform_integrations (platform_type);

-- platform_sync_logs
CREATE INDEX idx_platform_sync_logs_created     ON platform_sync_logs (created_at DESC);
CREATE INDEX idx_platform_sync_logs_integration ON platform_sync_logs (platform_integration_id);

-- platform_user_mappings
CREATE INDEX idx_platform_user_mappings_external ON platform_user_mappings (external_user_id);
CREATE INDEX idx_platform_user_mappings_profile  ON platform_user_mappings (profile_id);

-- profiles
CREATE INDEX idx_profiles_department ON profiles (department_id);
CREATE INDEX idx_profiles_email      ON profiles (email);
CREATE INDEX idx_profiles_role       ON profiles (role);

-- proposal_attachments
CREATE INDEX idx_proposal_attachments_active      ON proposal_attachments (proposal_id, is_active);
CREATE INDEX idx_proposal_attachments_proposal_id ON proposal_attachments (proposal_id);

-- purchase_orders
CREATE INDEX idx_purchase_orders_active       ON purchase_orders (is_active) WHERE is_active = true;
CREATE INDEX idx_purchase_orders_buyer        ON purchase_orders (buyer_id) WHERE is_active = true;
CREATE INDEX idx_purchase_orders_expense_type ON purchase_orders (expense_type) WHERE is_active = true;
CREATE INDEX idx_purchase_orders_po_number    ON purchase_orders (po_number);
CREATE INDEX idx_purchase_orders_requisition  ON purchase_orders (requisition_id);
CREATE INDEX idx_purchase_orders_status       ON purchase_orders (status) WHERE is_active = true;
CREATE INDEX idx_purchase_orders_supplier     ON purchase_orders (supplier_id) WHERE is_active = true;

-- purchase_types
CREATE INDEX idx_purchase_types_active ON purchase_types (is_active) WHERE is_active = true;

-- requisition_history
CREATE INDEX idx_requisition_history_changed_at  ON requisition_history (changed_at);
CREATE INDEX idx_requisition_history_changed_by  ON requisition_history (changed_by);
CREATE INDEX idx_requisition_history_requisition ON requisition_history (requisition_id);

-- requisitions
CREATE INDEX idx_requisitions_active        ON requisitions (is_active) WHERE is_active = true;
CREATE INDEX idx_requisitions_buyer         ON requisitions (buyer_id) WHERE is_active = true;
CREATE INDEX idx_requisitions_created_date  ON requisitions (created_date) WHERE is_active = true;
CREATE INDEX idx_requisitions_department    ON requisitions (department_id) WHERE is_active = true;
CREATE INDEX idx_requisitions_requester     ON requisitions (requester_id) WHERE is_active = true;
CREATE INDEX idx_requisitions_rq_number     ON requisitions (rq_number);
CREATE INDEX idx_requisitions_source        ON requisitions (source) WHERE is_active = true;
CREATE INDEX idx_requisitions_status        ON requisitions (status) WHERE is_active = true;

-- sat_declarations
CREATE INDEX idx_sat_declarations_active     ON sat_declarations (is_active) WHERE is_active = true;
CREATE INDEX idx_sat_declarations_ejercicio  ON sat_declarations (ejercicio);
CREATE INDEX idx_sat_declarations_periodo    ON sat_declarations (periodo);

-- shareholding_detail
CREATE INDEX idx_shareholding_detail_record ON shareholding_detail (shareholding_record_id);

-- shareholding_records
CREATE INDEX idx_shareholding_records_effective_date ON shareholding_records (effective_date);
CREATE INDEX idx_shareholding_records_version        ON shareholding_records (version DESC);

-- suppliers
CREATE INDEX idx_suppliers_active     ON suppliers (is_active) WHERE is_active = true;
CREATE INDEX idx_suppliers_blocked    ON suppliers (is_blocked) WHERE is_blocked = true;
CREATE INDEX idx_suppliers_legal_name ON suppliers (legal_name);
CREATE INDEX idx_suppliers_tax_id     ON suppliers (tax_id);

-- sync_logs
CREATE INDEX idx_sync_logs_source     ON sync_logs (source);
CREATE INDEX idx_sync_logs_started_at ON sync_logs (started_at DESC);
CREATE INDEX idx_sync_logs_status     ON sync_logs (status);

-- training_requests
CREATE INDEX idx_training_requests_profile      ON training_requests (profile_id) WHERE is_active = true;
CREATE INDEX idx_training_requests_requested_by ON training_requests (requested_by) WHERE is_active = true;
CREATE INDEX idx_training_requests_status       ON training_requests (status) WHERE is_active = true;

-- user_roles
CREATE INDEX idx_user_roles_module_role ON user_roles (module, role) WHERE is_active = true;
CREATE INDEX idx_user_roles_profile     ON user_roles (profile_id) WHERE is_active = true;
CREATE INDEX idx_user_roles_role        ON user_roles (role) WHERE is_active = true;

-- =============================================================================
-- 6. GRANTs al rol de aplicación (abent3t_app)
--    Los DEFAULT PRIVILEGES (configurados al crear el rol) NO aplican a
--    objetos creados en la MISMA transacción ni a objetos creados antes,
--    por eso aquí los concedemos explícitamente.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO abent3t_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO abent3t_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO abent3t_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO abent3t_app;

COMMIT;

-- =============================================================================
-- FIN — 0001_baseline_schema.sql
-- Próximos archivos:
--   * 0002_local_credentials.sql  — tabla de fallback email+password (K-8).
--   * 0003_seed_*.sql             — datos semilla / migración de datos reales.
-- =============================================================================
