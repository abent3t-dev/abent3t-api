-- =============================================
-- Migración: Mover campos de pago de courses a course_editions
-- Fecha: 2026-04-14
-- Descripción: Permite que cada edición tenga su propio costo y pago
-- =============================================

-- 1. Agregar nuevos campos a course_editions
ALTER TABLE course_editions
ADD COLUMN IF NOT EXISTS cost_override NUMERIC DEFAULT NULL,
ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'cancelled', 'na')),
ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS payment_date DATE DEFAULT NULL;

-- 2. Comentarios para documentar los campos
COMMENT ON COLUMN course_editions.cost_override IS 'Costo específico de esta edición. Si es NULL, se usa el costo del curso padre (courses.cost)';
COMMENT ON COLUMN course_editions.payment_status IS 'Estado de pago de esta edición: pending, paid, cancelled, na';
COMMENT ON COLUMN course_editions.payment_reference IS 'Referencia de pago (factura, transferencia, etc.) de esta edición';
COMMENT ON COLUMN course_editions.payment_date IS 'Fecha de pago de esta edición';

-- 3. (OPCIONAL) Migrar datos existentes: copiar payment_* del curso a todas sus ediciones
-- Descomenta si quieres migrar los datos existentes
/*
UPDATE course_editions ce
SET
    payment_status = c.payment_status,
    payment_reference = c.payment_reference,
    payment_date = c.payment_date
FROM courses c
WHERE ce.course_id = c.id
AND c.payment_status IS NOT NULL;
*/

-- 4. Crear índice para consultas de reportes por estado de pago
CREATE INDEX IF NOT EXISTS idx_course_editions_payment_status ON course_editions(payment_status) WHERE is_active = true;

-- 5. Crear vista para obtener costo efectivo (COALESCE)
CREATE OR REPLACE VIEW v_editions_with_effective_cost AS
SELECT
    ce.*,
    c.name AS course_name,
    c.cost AS base_cost,
    COALESCE(ce.cost_override, c.cost) AS effective_cost
FROM course_editions ce
JOIN courses c ON ce.course_id = c.id
WHERE ce.is_active = true;

-- =============================================
-- NOTAS:
-- - El campo payment_status en courses NO se elimina (backward compatibility)
-- - Reportes deben usar el costo efectivo: COALESCE(edition.cost_override, course.cost)
-- - El frontend debe mostrar el pago a nivel de edición
-- =============================================
