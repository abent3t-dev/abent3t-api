-- Migration: 015_user_roles_multi_module.sql
-- Feature: Roles múltiples por módulo (un usuario puede tener roles
--          distintos en distintos módulos del sistema).
-- Date: 2026-05-06
--
-- Contexto:
-- Hoy `profiles.role` es un solo enum, lo que impide que una persona tenga
-- roles distintos en distintos módulos (ej: admin_rh en Capacitación y
-- aprobador_nivel_1 en Compras). Esta migración:
--   1. Crea un enum `user_module` para identificar los módulos del sistema.
--   2. Crea la tabla `user_roles` como unión entre profile + módulo + rol.
--   3. Pobla `user_roles` a partir de `profiles.role` existente.
--   4. Mantiene `profiles.role` como rol "primario" (retrocompatibilidad).
--      Se podrá deprecar más adelante cuando todo el código consulte la
--      tabla nueva.

-- =====================================================
-- 1. ENUM DE MÓDULOS
-- =====================================================
CREATE TYPE user_module AS ENUM (
  'core',          -- Roles transversales: super_admin, executive
  'capacitacion',  -- Sistema de capacitación (admin_rh, jefe_area, colaborador, etc.)
  'compras',       -- Procurement (solicitante, comprador, aprobadores, etc.)
  'contabilidad'   -- Contabilidad y fiscal (contabilidad, fiscal, accionista, etc.)
);

-- =====================================================
-- 2. TABLA user_roles
-- =====================================================
CREATE TABLE IF NOT EXISTS user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  module user_module NOT NULL,
  role user_role NOT NULL,

  -- Auditoría
  granted_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  granted_by UUID REFERENCES profiles(id),
  revoked_at TIMESTAMP WITH TIME ZONE,
  revoked_by UUID REFERENCES profiles(id),

  -- Estado
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),

  -- Una persona no puede tener el mismo (módulo, rol) duplicado
  CONSTRAINT user_roles_unique UNIQUE (profile_id, module, role)
);

-- Índices para queries comunes
CREATE INDEX IF NOT EXISTS idx_user_roles_profile
  ON user_roles(profile_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_user_roles_module_role
  ON user_roles(module, role) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_user_roles_role
  ON user_roles(role) WHERE is_active = true;

COMMENT ON TABLE user_roles IS
  'Roles de un usuario por módulo. Una persona puede tener N roles, distribuidos en módulos distintos. profiles.role se mantiene como rol primario por retrocompatibilidad.';

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION update_user_roles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_user_roles_updated
  BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION update_user_roles_updated_at();

-- =====================================================
-- 3. POBLAR DESDE profiles.role EXISTENTE
-- =====================================================
INSERT INTO user_roles (profile_id, module, role, is_active)
SELECT
  p.id,
  CASE
    -- core: roles transversales
    WHEN p.role IN ('super_admin', 'executive') THEN 'core'::user_module
    -- compras
    WHEN p.role IN (
      'comprador', 'coordinador_compras', 'lider_procura',
      'aprobador_nivel_1', 'aprobador_nivel_2', 'aprobador_nivel_3',
      'director_general', 'solicitante'
    ) THEN 'compras'::user_module
    -- contabilidad
    WHEN p.role IN ('contabilidad', 'fiscal', 'director_financiero', 'accionista')
      THEN 'contabilidad'::user_module
    -- capacitacion (default para admin_rh, jefe_area, director, colaborador, collaborator)
    ELSE 'capacitacion'::user_module
  END,
  p.role,
  p.is_active
FROM profiles p
WHERE p.role IS NOT NULL
ON CONFLICT (profile_id, module, role) DO NOTHING;

-- =====================================================
-- 4. CASO DE PRUEBA: Colaborador test (multi-módulo)
-- =====================================================
-- Asignar a "Colaborador test" (allpall@outlook.es) el rol adicional
-- de aprobador_nivel_1 en Compras, para validar el escenario multi-módulo.
INSERT INTO user_roles (profile_id, module, role, is_active)
VALUES (
  'da20a7fb-8457-461a-9383-5524fbca5083'::uuid,
  'compras'::user_module,
  'aprobador_nivel_1'::user_role,
  true
)
ON CONFLICT (profile_id, module, role) DO NOTHING;
