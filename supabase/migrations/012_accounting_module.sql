-- ============================================
-- MIGRACION 012: MODULO DE CONTABILIDAD Y COMPLIANCE FISCAL
-- ============================================
-- Fecha: 2026-04-20
-- Descripcion: Estructura de base de datos para el modulo de Contabilidad
-- Incluye: nuevos roles, integraciones SAP/SAT, perdidas fiscales, no deducibles,
--          tenencia accionaria, OKRs y compliance
-- ============================================

-- ============================================
-- 1. NUEVOS ROLES
-- ============================================

-- Agregar nuevos roles al enum user_role
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'contabilidad';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'fiscal';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'director_financiero';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'accionista';

-- ============================================
-- 2. NUEVOS ENUMS
-- ============================================

-- Estado de sincronizacion con sistemas externos
CREATE TYPE sync_status AS ENUM ('pending', 'running', 'success', 'error');

-- Tipo de CFDI del SAT
CREATE TYPE cfdi_type AS ENUM ('I', 'E', 'P', 'N', 'T');

-- Estado de perdida fiscal
CREATE TYPE fiscal_loss_status AS ENUM ('vigente', 'proxima_a_vencer', 'vencida', 'amortizada_total');

-- Estado del cruce de complementos de pago
CREATE TYPE payment_reconciliation_status AS ENUM ('conciliado', 'diferencia_monto', 'solo_en_sap', 'solo_en_sat');

-- Tipo de OKR
CREATE TYPE okr_type AS ENUM ('objective', 'key_result');

-- Estado de OKR
CREATE TYPE okr_status AS ENUM ('on_track', 'at_risk', 'behind', 'completed');

-- ============================================
-- 3. TABLAS DE INTEGRACIONES
-- ============================================

-- Configuracion de conexion SAP B1
CREATE TABLE IF NOT EXISTS sap_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment VARCHAR(50) NOT NULL DEFAULT 'production',
  base_url TEXT NOT NULL,
  company_db VARCHAR(100) NOT NULL,
  username VARCHAR(100) NOT NULL,
  encrypted_password TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  last_sync_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Configuracion de credenciales SAT
-- NOTA: Los campos encrypted_* NUNCA deben exponerse en APIs
CREATE TABLE IF NOT EXISTS sat_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfc VARCHAR(13) NOT NULL UNIQUE,
  encrypted_ciec TEXT,
  encrypted_efirma_cer TEXT,
  encrypted_efirma_key TEXT,
  efirma_password_hint VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  validated_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Log de sincronizaciones
CREATE TABLE IF NOT EXISTS sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(20) NOT NULL CHECK (source IN ('sap', 'sat')),
  sync_type VARCHAR(50) NOT NULL,
  status sync_status DEFAULT 'pending',
  records_fetched INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  finished_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_sync_logs_source ON sync_logs(source);
CREATE INDEX idx_sync_logs_status ON sync_logs(status);
CREATE INDEX idx_sync_logs_started_at ON sync_logs(started_at DESC);

-- ============================================
-- 4. TABLAS DE CFDIs Y DECLARACIONES
-- ============================================

-- CFDIs descargados del SAT
CREATE TABLE IF NOT EXISTS cfdis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uuid VARCHAR(36) NOT NULL UNIQUE,
  tipo cfdi_type NOT NULL,
  rfc_emisor VARCHAR(13) NOT NULL,
  nombre_emisor VARCHAR(250),
  rfc_receptor VARCHAR(13) NOT NULL,
  nombre_receptor VARCHAR(250),
  fecha_emision TIMESTAMP WITH TIME ZONE NOT NULL,
  fecha_certificacion TIMESTAMP WITH TIME ZONE,
  subtotal NUMERIC(18,2) DEFAULT 0,
  descuento NUMERIC(18,2) DEFAULT 0,
  total NUMERIC(18,2) NOT NULL,
  moneda VARCHAR(3) DEFAULT 'MXN',
  tipo_cambio NUMERIC(18,6) DEFAULT 1,
  forma_pago VARCHAR(50),
  metodo_pago VARCHAR(10),
  uso_cfdi VARCHAR(10),
  version_complementaria BOOLEAN DEFAULT false,
  uuid_relacionado VARCHAR(36),
  xml_content TEXT,
  status VARCHAR(50) DEFAULT 'vigente',
  downloaded_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_cfdis_uuid ON cfdis(uuid);
CREATE INDEX idx_cfdis_tipo ON cfdis(tipo);
CREATE INDEX idx_cfdis_rfc_emisor ON cfdis(rfc_emisor);
CREATE INDEX idx_cfdis_rfc_receptor ON cfdis(rfc_receptor);
CREATE INDEX idx_cfdis_fecha_emision ON cfdis(fecha_emision);
CREATE INDEX idx_cfdis_active ON cfdis(is_active) WHERE is_active = true;

-- Declaraciones del SAT
CREATE TABLE IF NOT EXISTS sat_declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_declaracion VARCHAR(50) NOT NULL,
  ejercicio INTEGER NOT NULL,
  periodo VARCHAR(20) NOT NULL,
  fecha_presentacion TIMESTAMP WITH TIME ZONE NOT NULL,
  fecha_limite TIMESTAMP WITH TIME ZONE,
  acuse_url TEXT,
  monto_a_cargo NUMERIC(18,2) DEFAULT 0,
  monto_a_favor NUMERIC(18,2) DEFAULT 0,
  monto_pagado NUMERIC(18,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'presentada',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_sat_declarations_ejercicio ON sat_declarations(ejercicio);
CREATE INDEX idx_sat_declarations_periodo ON sat_declarations(periodo);
CREATE INDEX idx_sat_declarations_active ON sat_declarations(is_active) WHERE is_active = true;

-- ============================================
-- 5. TABLAS DE PERDIDAS FISCALES
-- ============================================

-- Catalogo de factores INPC
CREATE TABLE IF NOT EXISTS inpc_factors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  factor NUMERIC(10,6) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(year, month)
);

CREATE INDEX idx_inpc_factors_year_month ON inpc_factors(year, month);

-- Perdidas fiscales
CREATE TABLE IF NOT EXISTS fiscal_losses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ejercicio INTEGER NOT NULL,
  fecha_declaracion DATE NOT NULL,
  fecha_vencimiento DATE NOT NULL,
  monto_original NUMERIC(18,2) NOT NULL,
  factor_actualizacion NUMERIC(10,6) DEFAULT 1,
  monto_actualizado NUMERIC(18,2) NOT NULL,
  amortizado NUMERIC(18,2) DEFAULT 0,
  saldo_pendiente NUMERIC(18,2) NOT NULL,
  status fiscal_loss_status DEFAULT 'vigente',
  notes TEXT,
  created_by UUID REFERENCES profiles(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_fiscal_losses_ejercicio ON fiscal_losses(ejercicio);
CREATE INDEX idx_fiscal_losses_status ON fiscal_losses(status);
CREATE INDEX idx_fiscal_losses_fecha_vencimiento ON fiscal_losses(fecha_vencimiento);
CREATE INDEX idx_fiscal_losses_active ON fiscal_losses(is_active) WHERE is_active = true;

-- Amortizaciones de perdidas fiscales
CREATE TABLE IF NOT EXISTS fiscal_loss_amortizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_loss_id UUID NOT NULL REFERENCES fiscal_losses(id) ON DELETE CASCADE,
  ejercicio_aplicacion INTEGER NOT NULL,
  monto_amortizado NUMERIC(18,2) NOT NULL,
  declaracion_id UUID REFERENCES sat_declarations(id),
  notes TEXT,
  created_by UUID REFERENCES profiles(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_fiscal_loss_amortizations_fiscal_loss ON fiscal_loss_amortizations(fiscal_loss_id);
CREATE INDEX idx_fiscal_loss_amortizations_ejercicio ON fiscal_loss_amortizations(ejercicio_aplicacion);

-- ============================================
-- 6. TABLAS DE NO DEDUCIBLES Y TENENCIA
-- ============================================

-- Gastos no deducibles
CREATE TABLE IF NOT EXISTS non_deductibles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  periodo VARCHAR(7) NOT NULL,  -- YYYY-MM
  concepto VARCHAR(255) NOT NULL,
  monto NUMERIC(18,2) NOT NULL,
  department_id UUID REFERENCES departments(id),
  cfdi_uuid VARCHAR(36),
  notes TEXT,
  created_by UUID REFERENCES profiles(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_non_deductibles_periodo ON non_deductibles(periodo);
CREATE INDEX idx_non_deductibles_department ON non_deductibles(department_id);
CREATE INDEX idx_non_deductibles_active ON non_deductibles(is_active) WHERE is_active = true;

-- Tenencia accionaria (versiones/snapshots)
CREATE TABLE IF NOT EXISTS shareholding_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL,
  effective_date DATE NOT NULL,
  event_description TEXT,
  created_by UUID REFERENCES profiles(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_shareholding_records_version ON shareholding_records(version DESC);
CREATE INDEX idx_shareholding_records_effective_date ON shareholding_records(effective_date);

-- Detalle de tenencia accionaria
CREATE TABLE IF NOT EXISTS shareholding_detail (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shareholding_record_id UUID NOT NULL REFERENCES shareholding_records(id) ON DELETE CASCADE,
  accionista_nombre VARCHAR(255) NOT NULL,
  rfc VARCHAR(13),
  tipo_accion VARCHAR(50) DEFAULT 'ordinaria',
  porcentaje NUMERIC(6,3) NOT NULL CHECK (porcentaje >= 0 AND porcentaje <= 100),
  num_acciones INTEGER,
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_shareholding_detail_record ON shareholding_detail(shareholding_record_id);

-- ============================================
-- 7. TABLAS DE OKRs Y COMPLIANCE
-- ============================================

-- OKRs del area de contabilidad y fiscal
CREATE TABLE IF NOT EXISTS accounting_okrs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo VARCHAR(255) NOT NULL,
  descripcion TEXT,
  periodo VARCHAR(20) NOT NULL,  -- Q1-2026, 2026, etc.
  tipo okr_type NOT NULL,
  parent_okr_id UUID REFERENCES accounting_okrs(id),
  target_value NUMERIC(18,2),
  current_value NUMERIC(18,2) DEFAULT 0,
  unit VARCHAR(50),  -- %, dias, pesos, etc.
  status okr_status DEFAULT 'on_track',
  due_date DATE,
  created_by UUID REFERENCES profiles(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_accounting_okrs_periodo ON accounting_okrs(periodo);
CREATE INDEX idx_accounting_okrs_tipo ON accounting_okrs(tipo);
CREATE INDEX idx_accounting_okrs_parent ON accounting_okrs(parent_okr_id);
CREATE INDEX idx_accounting_okrs_status ON accounting_okrs(status);
CREATE INDEX idx_accounting_okrs_active ON accounting_okrs(is_active) WHERE is_active = true;

-- Cruce de complementos de pago SAP vs SAT (CFDI tipo P)
CREATE TABLE IF NOT EXISTS payment_complement_reconciliation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  periodo VARCHAR(7) NOT NULL,  -- YYYY-MM
  sap_payment_id VARCHAR(100),
  cfdi_uuid VARCHAR(36),
  rfc_proveedor VARCHAR(13),
  proveedor_nombre VARCHAR(255),
  monto_sap NUMERIC(18,2),
  monto_sat NUMERIC(18,2),
  difference_amount NUMERIC(18,2) DEFAULT 0,
  status payment_reconciliation_status NOT NULL,
  reviewed_by UUID REFERENCES profiles(id),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_payment_reconciliation_periodo ON payment_complement_reconciliation(periodo);
CREATE INDEX idx_payment_reconciliation_status ON payment_complement_reconciliation(status);
CREATE INDEX idx_payment_reconciliation_active ON payment_complement_reconciliation(is_active) WHERE is_active = true;

-- ============================================
-- 8. EXTENDER AUDIT LOGS
-- ============================================

-- Agregar nuevas entidades al enum audit_entity
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'fiscal_loss';
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'fiscal_loss_amortization';
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'non_deductible';
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'shareholding';
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'okr';
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'sap_config';
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'sat_config';
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'payment_reconciliation';
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'cfdi';

-- ============================================
-- 9. TRIGGERS PARA UPDATED_AT
-- ============================================

-- Funcion para actualizar updated_at
CREATE OR REPLACE FUNCTION update_accounting_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers para tablas con updated_at
CREATE TRIGGER tr_sap_connections_updated_at
  BEFORE UPDATE ON sap_connections
  FOR EACH ROW EXECUTE FUNCTION update_accounting_updated_at();

CREATE TRIGGER tr_sat_credentials_updated_at
  BEFORE UPDATE ON sat_credentials
  FOR EACH ROW EXECUTE FUNCTION update_accounting_updated_at();

CREATE TRIGGER tr_fiscal_losses_updated_at
  BEFORE UPDATE ON fiscal_losses
  FOR EACH ROW EXECUTE FUNCTION update_accounting_updated_at();

CREATE TRIGGER tr_non_deductibles_updated_at
  BEFORE UPDATE ON non_deductibles
  FOR EACH ROW EXECUTE FUNCTION update_accounting_updated_at();

CREATE TRIGGER tr_accounting_okrs_updated_at
  BEFORE UPDATE ON accounting_okrs
  FOR EACH ROW EXECUTE FUNCTION update_accounting_updated_at();

-- ============================================
-- 10. RLS POLICIES (Row Level Security)
-- ============================================

-- Habilitar RLS en todas las tablas
ALTER TABLE sap_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE sat_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cfdis ENABLE ROW LEVEL SECURITY;
ALTER TABLE sat_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inpc_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_losses ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_loss_amortizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE non_deductibles ENABLE ROW LEVEL SECURITY;
ALTER TABLE shareholding_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE shareholding_detail ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_okrs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_complement_reconciliation ENABLE ROW LEVEL SECURITY;

-- Politicas para super_admin (acceso total)
CREATE POLICY "super_admin_all_sap" ON sap_connections FOR ALL
  USING (auth.jwt() ->> 'role' = 'super_admin');

CREATE POLICY "super_admin_all_sat" ON sat_credentials FOR ALL
  USING (auth.jwt() ->> 'role' = 'super_admin');

-- Politicas de lectura para roles de contabilidad
CREATE POLICY "accounting_read_sync_logs" ON sync_logs FOR SELECT
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal', 'director_financiero'));

CREATE POLICY "accounting_read_cfdis" ON cfdis FOR SELECT
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal', 'director_financiero'));

CREATE POLICY "accounting_read_declarations" ON sat_declarations FOR SELECT
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal', 'director_financiero'));

CREATE POLICY "accounting_read_inpc" ON inpc_factors FOR SELECT
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal', 'director_financiero', 'accionista', 'executive'));

CREATE POLICY "accounting_read_fiscal_losses" ON fiscal_losses FOR SELECT
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal', 'director_financiero'));

CREATE POLICY "accounting_read_non_deductibles" ON non_deductibles FOR SELECT
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal', 'director_financiero'));

CREATE POLICY "accounting_read_shareholding" ON shareholding_records FOR SELECT
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal', 'director_financiero', 'accionista'));

CREATE POLICY "accounting_read_shareholding_detail" ON shareholding_detail FOR SELECT
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal', 'director_financiero', 'accionista'));

CREATE POLICY "accounting_read_okrs" ON accounting_okrs FOR SELECT
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal', 'director_financiero', 'executive'));

CREATE POLICY "accounting_read_reconciliation" ON payment_complement_reconciliation FOR SELECT
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal'));

-- Politicas de escritura para equipo de contabilidad
CREATE POLICY "accounting_write_fiscal_losses" ON fiscal_losses FOR ALL
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal'));

CREATE POLICY "accounting_write_amortizations" ON fiscal_loss_amortizations FOR ALL
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal'));

CREATE POLICY "accounting_write_non_deductibles" ON non_deductibles FOR ALL
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal'));

CREATE POLICY "accounting_write_shareholding" ON shareholding_records FOR ALL
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal'));

CREATE POLICY "accounting_write_shareholding_detail" ON shareholding_detail FOR ALL
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal'));

CREATE POLICY "accounting_write_okrs" ON accounting_okrs FOR ALL
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal'));

CREATE POLICY "accounting_write_reconciliation" ON payment_complement_reconciliation FOR ALL
  USING (auth.jwt() ->> 'role' IN ('super_admin', 'contabilidad', 'fiscal'));

-- ============================================
-- FIN DE MIGRACION
-- ============================================

COMMENT ON TABLE sap_connections IS 'Configuracion de conexion al Service Layer de SAP B1';
COMMENT ON TABLE sat_credentials IS 'Credenciales encriptadas para acceso al SAT (CIEC y e.firma)';
COMMENT ON TABLE sync_logs IS 'Registro de sincronizaciones con sistemas externos';
COMMENT ON TABLE cfdis IS 'CFDIs descargados del portal del SAT';
COMMENT ON TABLE sat_declarations IS 'Declaraciones fiscales del SAT';
COMMENT ON TABLE inpc_factors IS 'Catalogo de factores INPC para actualizacion de perdidas';
COMMENT ON TABLE fiscal_losses IS 'Perdidas fiscales pendientes de amortizar';
COMMENT ON TABLE fiscal_loss_amortizations IS 'Registro de amortizaciones aplicadas a perdidas fiscales';
COMMENT ON TABLE non_deductibles IS 'Gastos no deducibles agrupados por departamento';
COMMENT ON TABLE shareholding_records IS 'Versiones de la estructura de tenencia accionaria';
COMMENT ON TABLE shareholding_detail IS 'Detalle de accionistas por version de tenencia';
COMMENT ON TABLE accounting_okrs IS 'Objetivos y resultados clave del area de contabilidad';
COMMENT ON TABLE payment_complement_reconciliation IS 'Cruce de complementos de pago SAP vs CFDI tipo P';
