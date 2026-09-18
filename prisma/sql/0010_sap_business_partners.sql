-- =============================================================================
-- 0010_sap_business_partners.sql — Proveedores desde SAP (Compras)
--
-- Petición de Ingrid 2026-09-18 + decisión del principal: poblar el catálogo
-- EXISTENTE de proveedores con los BusinessPartners tipo proveedor de SAP
-- (datos básicos: nombre/RFC/contacto/email/moneda), en SOLO LECTURA desde
-- SAP; la puntuación y el estado (bloqueo/activo) siguen siendo de ABENT.
--
--   * sap_business_partners — staging (tercer target del sync SAP de Int-4),
--     una fila por CardCode; cambio por raw_hash (mismo patrón que 0009).
--   * suppliers — columnas de ORIGEN: source ('manual' | 'sap') +
--     external_id (CardCode), moneda y los flags informativos de SAP
--     (sap_valid / sap_frozen — NO sustituyen is_blocked/is_active de ABENT).
--
-- Validado en vivo contra PRD_ABENT (2026-09-18): 873 cSupplier (808 "P" +
-- 65 "E" empleados-acreedores), 0 RFC nulos pero 52 filas con RFC DUPLICADO
-- (43 comparten el genérico de extranjeros XEXX010101000). Por eso:
--   * tax_id se amplía a varchar(40): los duplicados usan "RFC-CardCode"
--     (conserva el RFC visible y respeta el UNIQUE).
-- =============================================================================

BEGIN;

-- Tercer target del sync SAP (el valor no se usa dentro de esta migración,
-- por lo que puede ir en la misma transacción).
ALTER TYPE sap_sync_target ADD VALUE IF NOT EXISTS 'business_partners';

-- -----------------------------------------------------------------------------
-- Staging de BusinessPartners (una fila por CardCode)
-- -----------------------------------------------------------------------------
CREATE TABLE sap_business_partners (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_code          varchar(50) NOT NULL,
  card_name          varchar(255),
  card_type          varchar(20),        -- cSupplier (filtro del sync)
  federal_tax_id     varchar(40),        -- RFC
  email              varchar(255),
  phone1             varchar(50),
  phone2             varchar(50),
  contact_person     varchar(255),
  website            varchar(255),
  currency           varchar(10),        -- '##' = multimoneda en SAP B1
  sap_valid          boolean,            -- Valid = tYES
  sap_frozen         boolean,            -- Frozen = tYES
  update_date_source timestamptz,
  raw_hash           varchar(64) NOT NULL,
  raw                jsonb NOT NULL,
  mapper_version     text  NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_changed_at    timestamptz,
  last_sync_run_id   uuid REFERENCES sap_sync_runs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX uq_sap_bp_card_code ON sap_business_partners (card_code);
CREATE INDEX idx_sap_bp_update_date ON sap_business_partners (update_date_source);

COMMENT ON TABLE sap_business_partners IS
  'Staging de BusinessPartners (cSupplier) de SAP B1. El espejo al catálogo suppliers lo hace el dominio (SupplierSapMirrorService).';

-- -----------------------------------------------------------------------------
-- suppliers: origen del registro (el espejo escribe SOLO los básicos)
-- -----------------------------------------------------------------------------
ALTER TABLE suppliers
  ALTER COLUMN tax_id TYPE varchar(40),
  ADD COLUMN source      varchar(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN external_id varchar(50),
  ADD COLUMN currency    varchar(10),
  ADD COLUMN sap_valid   boolean,
  ADD COLUMN sap_frozen  boolean;

CREATE UNIQUE INDEX uq_suppliers_source_external
  ON suppliers (source, external_id) WHERE external_id IS NOT NULL;

COMMENT ON COLUMN suppliers.source IS
  'manual (alta en ABENT) | sap (espejado de SAP: los básicos son solo lectura; puntuación/bloqueo/activo siguen siendo de ABENT).';
COMMENT ON COLUMN suppliers.sap_valid IS
  'Informativo: Valid de SAP. NO sustituye is_active/is_blocked de ABENT.';

-- -----------------------------------------------------------------------------
-- Permisos (mismo patrón que 0009; suppliers ya tiene permisos del CRUD)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON sap_business_partners TO abent3t_app;

COMMIT;
