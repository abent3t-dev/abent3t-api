-- Migration: 013_platform_integration_slug.sql
-- Feature: Adaptaciones para integración Crehana v5 (lectura)
-- Date: 2026-04-29
--
-- Cambios:
-- 1. organization_slug en platform_integrations (lo requiere el path de Crehana v5)
-- 2. profile_id nullable en platform_user_mappings y platform_enrollments,
--    para poder sincronizar usuarios/inscripciones de Crehana aunque todavía
--    no exista coincidencia por email con un perfil de ABENT
--    (mientras no se completen los correos institucionales).
-- 3. Reemplazar constraint único de enrollments para soportar profile_id NULL.

-- =====================================================
-- 1. ORGANIZATION SLUG
-- =====================================================

ALTER TABLE platform_integrations
  ADD COLUMN IF NOT EXISTS organization_slug VARCHAR(255);

COMMENT ON COLUMN platform_integrations.organization_slug IS
  'Slug de la organización en la plataforma externa. Para Crehana se usa en el path: /api/v5/rest/org/{slug}/. Opcional para plataformas que no lo requieren.';

-- =====================================================
-- 2. PROFILE_ID NULLABLE
-- =====================================================

ALTER TABLE platform_user_mappings
  ALTER COLUMN profile_id DROP NOT NULL;

ALTER TABLE platform_enrollments
  ALTER COLUMN profile_id DROP NOT NULL;

COMMENT ON COLUMN platform_user_mappings.profile_id IS
  'Perfil interno de ABENT. NULL si el usuario existe en la plataforma externa pero todavía no hay coincidencia por email con un perfil interno.';

COMMENT ON COLUMN platform_enrollments.profile_id IS
  'Perfil interno de ABENT. NULL si la inscripción es de un usuario sin coincidencia por email en ABENT.';

-- =====================================================
-- 3. CONSTRAINTS DE UNICIDAD
-- =====================================================

-- platform_user_mappings: el unique por profile_id ya no aplica con NULLs.
-- El unique por external_user_id (creado en 008) sigue siendo correcto.
ALTER TABLE platform_user_mappings
  DROP CONSTRAINT IF EXISTS platform_user_mappings_profile_unique;

-- platform_enrollments: cambiamos el unique de (platform_course_id, profile_id)
-- a (platform_course_id, external_user_id). external_user_id sí está siempre presente.
ALTER TABLE platform_enrollments
  DROP CONSTRAINT IF EXISTS platform_enrollments_unique;

-- Garantizar que external_user_id existe para poder volverlo NOT NULL
UPDATE platform_enrollments
  SET external_user_id = ''
  WHERE external_user_id IS NULL;

ALTER TABLE platform_enrollments
  ALTER COLUMN external_user_id SET NOT NULL;

ALTER TABLE platform_enrollments
  ADD CONSTRAINT platform_enrollments_external_unique
  UNIQUE (platform_course_id, external_user_id);
