-- =====================================================
-- Migration: Payment control + Enrollment blocking rules
-- Tasks: A3-18 (Control de pago) + A3-19 (Regla de bloqueo)
-- =====================================================

-- =====================================================
-- A3-18: Control de pago de cursos
-- =====================================================

-- Add payment reference and date to courses
ALTER TABLE courses
ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255),
ADD COLUMN IF NOT EXISTS payment_date DATE;

-- Add comments for documentation
COMMENT ON COLUMN courses.payment_reference IS
  'Reference number or identifier for the payment (invoice, transfer, etc.)';

COMMENT ON COLUMN courses.payment_date IS
  'Date when the payment was made';

-- =====================================================
-- A3-19: Configuración de reglas de inscripción
-- =====================================================

-- Add configuration for enrollment blocking rule
-- This allows enabling/disabling the rule per organization
ALTER TABLE course_editions
ADD COLUMN IF NOT EXISTS require_evidence_for_completion BOOLEAN DEFAULT true;

COMMENT ON COLUMN course_editions.require_evidence_for_completion IS
  'If true, enrollment is considered incomplete without approved evidence.
   Collaborators cannot enroll in new courses until previous courses have approved evidence.';

-- =====================================================
-- Notes on business rules (A3-19):
--
-- Rule: Sin diploma/evidencia aprobada, el colaborador NO puede
--       inscribirse en otro curso
--
-- Implementation:
-- 1. Before enrolling, check if profile has any enrollment with:
--    - status != 'cancelado'
--    - status != 'completo'
--    - OR status = 'completo' but no approved evidence
-- 2. If found, block enrollment with clear message
-- 3. This rule can be bypassed by admin_rh if needed
-- =====================================================
