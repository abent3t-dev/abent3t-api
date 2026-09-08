-- ============================================================================
-- 0006_contracts.sql — Fase §15: Gestión de Contratos (repositorio documental)
-- ============================================================================
-- Repositorio documental de contratos con proveedores (PDFs en MinIO bucket
-- `contracts` + metadata aquí). NO confundir con `maximo_contracts` (staging
-- de solo lectura del sync de Maximo, 0005): son dos mundos sin FKs entre sí
-- y sin sincronización (regla 1 de la fase / nota de §15).
--
-- Aplicar con un superusuario/owner sobre abent3t_db; los GRANTs al final
-- dan acceso al rol de la app (mismo patrón que 0005).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
CREATE TYPE contract_document_type AS ENUM
  ('contrato', 'addenda', 'convenio', 'carta_compromiso', 'otro');
CREATE TYPE contract_status AS ENUM
  ('vigente', 'vencido', 'renovado', 'cancelado');

-- ----------------------------------------------------------------------------
-- Catálogo principal de contratos
-- ----------------------------------------------------------------------------
CREATE TABLE contracts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_number        text NOT NULL UNIQUE,          -- consecutivo (ej. "A3T001")
  tomo                   text,                          -- referencia física histórica ("Tomo 1")
  document_type          contract_document_type NOT NULL,
  service_description    text NOT NULL,
  supplier_id            uuid NOT NULL REFERENCES suppliers(id),

  -- Vigencia (end_date alimenta las alertas 30/7/0)
  start_date             date NOT NULL,
  end_date               date NOT NULL,

  -- Montos (opcionales)
  total_amount           numeric(14,2),
  currency               text DEFAULT 'MXN',

  -- Responsables (destinatarios de las alertas de vencimiento)
  buyer_profile_id       uuid REFERENCES profiles(id),
  responsible_user_email text,
  responsible_user_name  text,

  status                 contract_status NOT NULL DEFAULT 'vigente',
  notes                  text,

  -- Soft delete + auditoría (updated_at lo mantiene Prisma vía @updatedAt;
  -- el guard de borrado sigue siendo is_active=false, deleted_* es rastro extra)
  is_active              boolean NOT NULL DEFAULT true,
  created_by             uuid REFERENCES profiles(id),
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now(),
  deleted_at             timestamptz,
  deleted_by             uuid REFERENCES profiles(id)
);

-- Listado filtra por estatus/proveedor y el job diario barre por vigencia.
CREATE INDEX idx_contracts_status   ON contracts (status);
CREATE INDEX idx_contracts_supplier ON contracts (supplier_id);
CREATE INDEX idx_contracts_end_date ON contracts (end_date);

-- ----------------------------------------------------------------------------
-- Archivos del contrato (1 contrato → N versiones/anexos)
-- ----------------------------------------------------------------------------
CREATE TABLE contract_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     uuid NOT NULL REFERENCES contracts(id),
  file_name       text NOT NULL,
  storage_key     text NOT NULL,        -- key del objeto en el bucket `contracts`
  mime_type       text,
  file_size_bytes bigint,
  version         int NOT NULL DEFAULT 1,
  is_current      boolean NOT NULL DEFAULT true,  -- solo 1 vigente por contrato
  uploaded_by     uuid REFERENCES profiles(id),
  uploaded_at     timestamptz DEFAULT now()
);

CREATE INDEX idx_contract_documents_contract ON contract_documents (contract_id);

-- ----------------------------------------------------------------------------
-- Log de notificaciones de vencimiento enviadas (idempotencia del job 30/7/0)
-- ----------------------------------------------------------------------------
CREATE TABLE contract_expiry_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id       uuid NOT NULL REFERENCES contracts(id),
  notification_type text NOT NULL,      -- '30_days_before' | '7_days_before' | 'expired'
  recipient_email   text NOT NULL,
  recipient_role    text,               -- 'comprador' | 'responsible_user'
  sent_at           timestamptz DEFAULT now(),
  CONSTRAINT uq_contract_expiry_notif UNIQUE (contract_id, notification_type, recipient_email)
);

CREATE INDEX idx_contract_expiry_notif_contract
  ON contract_expiry_notifications (contract_id);

-- ----------------------------------------------------------------------------
-- Vínculo PO → contrato (A3): la columna existía solo en el DTO y el service
-- la descartaba porque esta tabla no existía. Nullable: solo obligatoria a
-- nivel de negocio cuando purchase_types.requires_contract = true.
-- ----------------------------------------------------------------------------
ALTER TABLE purchase_orders
  ADD COLUMN contract_id uuid REFERENCES contracts(id);

CREATE INDEX idx_purchase_orders_contract ON purchase_orders (contract_id);

-- ----------------------------------------------------------------------------
-- Permisos del rol de la aplicación (sin DELETE: soft delete por is_active)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON contracts                    TO abent3t_app;
GRANT SELECT, INSERT, UPDATE ON contract_documents           TO abent3t_app;
GRANT SELECT, INSERT, UPDATE ON contract_expiry_notifications TO abent3t_app;
