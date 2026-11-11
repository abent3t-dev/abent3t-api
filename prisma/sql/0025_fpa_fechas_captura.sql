-- =============================================================================
-- 0025 — FP&A, bloque C (C4): fecha límite de captura y prórroga por área
-- =============================================================================
-- Lo que pidió Laura el 4-nov y contestó el 10-nov (documentation/FPA.md,
-- "Reunión del 4-nov", punto 3; TAREAS_FPA_2026-11-04.md, C4):
--   * una fecha para todas las áreas: fpa_versions.capture_deadline, el último
--     día (hora de México) para capturar y enviar;
--   * al vencer, se bloquea: un área que no ha enviado (borrador) ya no captura
--     ni envía. Lo cuida el API, como el estado de la versión (B2);
--   * las firmas no llevan fecha: un presupuesto devuelto se corrige y se
--     reenvía sin fecha;
--   * planeación le da a un área una fecha nueva ("le abro este cacho y lo
--     vuelvo a cerrar"): fpa_budgets.capture_extended_until, con quién y
--     cuándo;
--   * el historial de los dos cambios va en fpa_version_events (solo
--     inserción), con las acciones nuevas 'fecha_limite' y 'prorroga'.
--
-- Aditiva y sin datos: las columnas nuevas quedan vacías (sin fecha, como hoy)
-- y los CHECK de fpa_version_events solo suman dos acciones. La B-26 de prod
-- no cambia. Los permisos de tabla de 0021 y 0022 cubren las columnas nuevas.
--
-- Despliegue: en el servidor B ANTES del rebuild que incluya C4 (el cliente de
-- Prisma de C4 ya lee estas columnas). Rollback: el código anterior no las lee;
-- la migración se puede quedar. Si una tabla está ocupada, espera hasta 5 s y
-- falla sin cambiar nada (lock_timeout): se vuelve a correr.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- Fecha límite de la versión
-- -----------------------------------------------------------------------------
ALTER TABLE fpa_versions
  ADD COLUMN capture_deadline date;

COMMENT ON COLUMN fpa_versions.capture_deadline IS
  'C4: último día (hora de México) para capturar y enviar, el mismo para todas las áreas. Al pasar, un presupuesto en borrador ya no se captura ni se envía, salvo con prórroga (fpa_budgets.capture_extended_until). NULL: sin fecha. Lo pone planeación en preparación o en captura; cada cambio queda en fpa_version_events (fecha_limite).';

-- -----------------------------------------------------------------------------
-- Prórroga de un área
-- -----------------------------------------------------------------------------
ALTER TABLE fpa_budgets
  ADD COLUMN capture_extended_until date,
  ADD COLUMN capture_extended_by    uuid REFERENCES profiles(id),
  ADD COLUMN capture_extended_at    timestamptz,
  -- La prórroga va completa (fecha, quién y cuándo) o no va
  ADD CONSTRAINT ck_fpa_budgets_extension CHECK (
        (capture_extended_until IS NULL) = (capture_extended_by IS NULL)
    AND (capture_extended_until IS NULL) = (capture_extended_at IS NULL));

COMMENT ON COLUMN fpa_budgets.capture_extended_until IS
  'C4: prórroga del área: captura y envía hasta este día (hora de México) aunque haya pasado la fecha de la versión. Vale la más tarde de las dos. NULL: sin prórroga. Cada cambio queda en fpa_version_events (prorroga).';
COMMENT ON COLUMN fpa_budgets.capture_extended_by IS
  'C4: quién dio la prórroga vigente (planeación o soporte).';
COMMENT ON COLUMN fpa_budgets.capture_extended_at IS
  'C4: cuándo se dio la prórroga vigente.';

-- -----------------------------------------------------------------------------
-- Historial: dos acciones nuevas, sin cambio de estado y con su detalle
-- -----------------------------------------------------------------------------
ALTER TABLE fpa_version_events
  DROP CONSTRAINT ck_fpa_version_events_action,
  ADD CONSTRAINT ck_fpa_version_events_action CHECK (action IN
    ('creada', 'parametros', 'visto_bueno', 'abierta', 'regresada',
     'cerrada', 'reabierta', 'fecha_limite', 'prorroga'));

ALTER TABLE fpa_version_events
  DROP CONSTRAINT ck_fpa_version_events_transition,
  ADD CONSTRAINT ck_fpa_version_events_transition CHECK (COALESCE(
       (action = 'creada'
        AND from_status IS NULL AND to_status = 'preparacion')
    OR (action IN ('parametros', 'visto_bueno', 'fecha_limite', 'prorroga')
        AND from_status IS NULL AND to_status IS NULL)
    OR (action = 'abierta'
        AND from_status = 'preparacion' AND to_status = 'captura')
    OR (action = 'regresada'
        AND from_status = 'captura' AND to_status = 'preparacion')
    OR (action = 'cerrada'
        AND from_status = 'captura' AND to_status = 'cerrada')
    OR (action = 'reabierta'
        AND from_status = 'cerrada' AND to_status = 'captura'),
    false));

-- La fecha y la prórroga guardan el antes y el después (y la prórroga, el área)
ALTER TABLE fpa_version_events
  DROP CONSTRAINT ck_fpa_version_events_detail,
  ADD CONSTRAINT ck_fpa_version_events_detail CHECK (
        (detail IS NULL OR jsonb_typeof(detail) = 'object')
    AND (action NOT IN ('parametros', 'visto_bueno', 'fecha_limite', 'prorroga')
         OR detail IS NOT NULL));

COMMENT ON COLUMN fpa_version_events.action IS
  'creada, parametros, visto_bueno, abierta, regresada, cerrada, reabierta; desde C4 (0025), fecha_limite (detail: antes y despues) y prorroga (detail: presupuesto, área, antes y despues).';

COMMIT;
