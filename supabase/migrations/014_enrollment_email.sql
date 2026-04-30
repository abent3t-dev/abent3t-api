-- Migration: 014_enrollment_email.sql
-- Feature: Agregar external_user_email a platform_enrollments para poder
-- emparejar usuarios entre los endpoints de Crehana.
-- Date: 2026-04-30
--
-- Contexto:
-- El endpoint `/users/user-organizations/` devuelve un user.id distinto al
-- `user_id` que aparece en `/reports/learning/general/`. Crehana usa IDs
-- diferentes en sus módulos de organización vs learning.
-- El email sí es el mismo en ambos endpoints, así que lo usamos como
-- llave de unión para mapear inscripciones a usuarios.

ALTER TABLE platform_enrollments
  ADD COLUMN IF NOT EXISTS external_user_email VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_platform_enrollments_email
  ON platform_enrollments(external_user_email);

COMMENT ON COLUMN platform_enrollments.external_user_email IS
  'Email del usuario en la plataforma externa. Usado para emparejar inscripciones con platform_user_mappings.external_email cuando los IDs no coinciden entre módulos (caso Crehana). Se llena durante el sync.';
