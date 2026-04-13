-- Migration: 008_platform_integrations.sql
-- Feature: Integración con plataformas de e-learning (Crehana, Udemy, etc.)
-- Date: 2026-04-13

-- =====================================================
-- ENUMS
-- =====================================================

-- Tipos de plataforma soportados
CREATE TYPE platform_type AS ENUM (
  'crehana',
  'udemy_business',
  'linkedin_learning',
  'coursera',
  'other'
);

-- Estados de sincronización
CREATE TYPE sync_status AS ENUM (
  'pending',
  'in_progress',
  'completed',
  'failed'
);

-- Estados de progreso en plataformas externas
CREATE TYPE platform_enrollment_status AS ENUM (
  'not_started',
  'in_progress',
  'completed',
  'expired'
);

-- =====================================================
-- TABLA: platform_integrations
-- Configuración de credenciales API por plataforma
-- =====================================================
CREATE TABLE IF NOT EXISTS platform_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id),
  platform_type platform_type NOT NULL DEFAULT 'crehana',

  -- Credenciales API
  api_url VARCHAR(500),
  public_key VARCHAR(500),
  private_key_encrypted TEXT,           -- Encriptada en aplicación

  -- Configuración de sincronización
  sync_enabled BOOLEAN DEFAULT true,
  sync_frequency_hours INTEGER DEFAULT 24,
  last_sync_at TIMESTAMP WITH TIME ZONE,
  last_sync_status sync_status DEFAULT 'pending',
  last_sync_error TEXT,

  -- SSO (Single Sign-On)
  sso_enabled BOOLEAN DEFAULT false,
  sso_type VARCHAR(50),                  -- 'saml2', 'microsoft', null
  sso_config JSONB,

  -- Metadatos
  configured_by UUID REFERENCES profiles(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),

  -- Constraints
  CONSTRAINT platform_integrations_institution_unique UNIQUE (institution_id)
);

-- Índices
CREATE INDEX idx_platform_integrations_type ON platform_integrations(platform_type);
CREATE INDEX idx_platform_integrations_sync ON platform_integrations(sync_enabled) WHERE sync_enabled = true;

COMMENT ON TABLE platform_integrations IS 'Configuración de integración con plataformas de e-learning';
COMMENT ON COLUMN platform_integrations.private_key_encrypted IS 'Clave privada encriptada - solo visible una vez al configurar';

-- =====================================================
-- TABLA: platform_courses
-- Catálogo de cursos sincronizados desde plataformas
-- =====================================================
CREATE TABLE IF NOT EXISTS platform_courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_integration_id UUID NOT NULL REFERENCES platform_integrations(id),

  -- Identificadores externos
  external_course_id VARCHAR(255) NOT NULL,
  external_track_id VARCHAR(255),

  -- Datos del curso
  name VARCHAR(500) NOT NULL,
  description TEXT,
  instructor VARCHAR(255),
  language VARCHAR(10) DEFAULT 'es',

  -- Métricas
  total_hours NUMERIC DEFAULT 0,
  total_modules INTEGER DEFAULT 0,
  total_lessons INTEGER DEFAULT 0,

  -- Clasificación (mapeo opcional con catálogos internos)
  course_type_id UUID REFERENCES course_types(id),
  modality_id UUID REFERENCES modalities(id),

  -- URLs
  course_url TEXT,
  thumbnail_url TEXT,

  -- Estado
  is_active BOOLEAN DEFAULT true,
  last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),

  -- Constraints
  CONSTRAINT platform_courses_external_unique UNIQUE (platform_integration_id, external_course_id)
);

-- Índices
CREATE INDEX idx_platform_courses_integration ON platform_courses(platform_integration_id);
CREATE INDEX idx_platform_courses_external ON platform_courses(external_course_id);
CREATE INDEX idx_platform_courses_name ON platform_courses(name);

COMMENT ON TABLE platform_courses IS 'Catálogo de cursos sincronizados desde plataformas externas';

-- =====================================================
-- TABLA: platform_user_mappings
-- Mapeo de usuarios internos con usuarios de plataforma
-- =====================================================
CREATE TABLE IF NOT EXISTS platform_user_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_integration_id UUID NOT NULL REFERENCES platform_integrations(id),
  profile_id UUID NOT NULL REFERENCES profiles(id),

  -- Identificador en plataforma externa
  external_user_id VARCHAR(255) NOT NULL,
  external_email VARCHAR(255),
  external_username VARCHAR(255),

  -- Estado
  is_active BOOLEAN DEFAULT true,
  last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),

  -- Constraints
  CONSTRAINT platform_user_mappings_profile_unique UNIQUE (platform_integration_id, profile_id),
  CONSTRAINT platform_user_mappings_external_unique UNIQUE (platform_integration_id, external_user_id)
);

-- Índices
CREATE INDEX idx_platform_user_mappings_profile ON platform_user_mappings(profile_id);
CREATE INDEX idx_platform_user_mappings_external ON platform_user_mappings(external_user_id);

COMMENT ON TABLE platform_user_mappings IS 'Mapeo de usuarios internos con usuarios de plataformas externas';

-- =====================================================
-- TABLA: platform_enrollments
-- Inscripciones/progreso de colaboradores en plataformas
-- =====================================================
CREATE TABLE IF NOT EXISTS platform_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_course_id UUID NOT NULL REFERENCES platform_courses(id),
  profile_id UUID NOT NULL REFERENCES profiles(id),

  -- Identificadores externos
  external_enrollment_id VARCHAR(255),
  external_user_id VARCHAR(255),

  -- Progreso
  progress_percentage NUMERIC DEFAULT 0 CHECK (progress_percentage >= 0 AND progress_percentage <= 100),
  status platform_enrollment_status DEFAULT 'not_started',

  -- Fechas
  enrolled_at TIMESTAMP WITH TIME ZONE,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  last_activity_at TIMESTAMP WITH TIME ZONE,

  -- Métricas
  hours_completed NUMERIC DEFAULT 0,
  modules_completed INTEGER DEFAULT 0,
  lessons_completed INTEGER DEFAULT 0,

  -- Certificado
  certificate_url TEXT,
  certificate_issued_at TIMESTAMP WITH TIME ZONE,

  -- Sincronización
  last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  sync_error TEXT,

  -- Estado
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),

  -- Constraints
  CONSTRAINT platform_enrollments_unique UNIQUE (platform_course_id, profile_id)
);

-- Índices
CREATE INDEX idx_platform_enrollments_profile ON platform_enrollments(profile_id);
CREATE INDEX idx_platform_enrollments_course ON platform_enrollments(platform_course_id);
CREATE INDEX idx_platform_enrollments_status ON platform_enrollments(status);
CREATE INDEX idx_platform_enrollments_progress ON platform_enrollments(progress_percentage);

COMMENT ON TABLE platform_enrollments IS 'Progreso de colaboradores en cursos de plataformas externas';

-- =====================================================
-- TABLA: platform_sync_logs
-- Historial de sincronizaciones
-- =====================================================
CREATE TABLE IF NOT EXISTS platform_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_integration_id UUID NOT NULL REFERENCES platform_integrations(id),

  -- Tipo de sincronización
  sync_type VARCHAR(50) NOT NULL CHECK (sync_type IN ('full', 'incremental', 'users', 'courses', 'progress')),

  -- Resultado
  status sync_status NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,

  -- Métricas
  courses_synced INTEGER DEFAULT 0,
  enrollments_synced INTEGER DEFAULT 0,
  users_synced INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,

  -- Detalles
  error_details JSONB,
  sync_summary JSONB,

  -- Usuario que inició (null si es automático)
  triggered_by UUID REFERENCES profiles(id),

  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Índices
CREATE INDEX idx_platform_sync_logs_integration ON platform_sync_logs(platform_integration_id);
CREATE INDEX idx_platform_sync_logs_created ON platform_sync_logs(created_at DESC);

COMMENT ON TABLE platform_sync_logs IS 'Historial de sincronizaciones con plataformas';

-- =====================================================
-- ACTUALIZAR ENUM audit_entity
-- =====================================================
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'platform_integration';
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'platform_course';
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'platform_enrollment';
ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'platform_sync';

-- =====================================================
-- FUNCIÓN: Actualizar updated_at automáticamente
-- =====================================================
CREATE OR REPLACE FUNCTION update_platform_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers para updated_at
CREATE TRIGGER trigger_platform_integrations_updated
  BEFORE UPDATE ON platform_integrations
  FOR EACH ROW EXECUTE FUNCTION update_platform_updated_at();

CREATE TRIGGER trigger_platform_courses_updated
  BEFORE UPDATE ON platform_courses
  FOR EACH ROW EXECUTE FUNCTION update_platform_updated_at();

CREATE TRIGGER trigger_platform_user_mappings_updated
  BEFORE UPDATE ON platform_user_mappings
  FOR EACH ROW EXECUTE FUNCTION update_platform_updated_at();

CREATE TRIGGER trigger_platform_enrollments_updated
  BEFORE UPDATE ON platform_enrollments
  FOR EACH ROW EXECUTE FUNCTION update_platform_updated_at();
