-- =============================================================================
-- 0024_fpa_catalogo_coa.sql — FP&A C1: qué clasificaciones ve cada área
--
-- Bloque C (documentation/TAREAS_FPA_2026-11-04.md, C1, y FPA.md, "Reunión del
-- 26-oct", punto 3): el catálogo de FP&A se carga del Chart of Accounts de A3T
-- (scripts/fpa-catalogo.ts). El COA dice qué parejas categoría › clasificación
-- tiene cada departamento (centro de costos GSGAD…, NAES y GE), y cada área ve
-- solo las de sus departamentos (decisión 16): Compras ve sus 8 categorías y no
-- las 37 de NAES.
--
--   * C1  fpa_department_classifications: una fila por departamento y
--         clasificación del COA. La llena fpa:catalogo; el catálogo
--         (GET /fpa/catalogo) dice en qué departamentos aplica cada
--         clasificación y la captura filtra por los del área. Una
--         clasificación sin filas (p. ej. Viajes › Viajes, la de los viajes
--         calculados) la ven todas las áreas.
--
-- Aditiva y sin datos: la tabla nace vacía y, mientras lo esté, la captura
-- enseña todo el catálogo, como hoy. No toca presupuestos ni líneas.
--
-- Despliegue: en el servidor B ANTES del rebuild que incluya C1 (el cliente de
-- Prisma de C1 ya pide esta tabla al leer el catálogo). Rollback: el código
-- anterior no la lee; la tabla se puede quedar. Si una tabla está ocupada,
-- espera hasta 5 s y falla sin cambiar nada (lock_timeout): se vuelve a correr.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE fpa_department_classifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id     uuid NOT NULL REFERENCES fpa_departments(id),
  classification_id uuid NOT NULL REFERENCES fpa_classifications(id),
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Una fila por pareja: dar de baja y volver a dar de alta reactiva la misma
  CONSTRAINT uq_fpa_department_classifications
    UNIQUE (department_id, classification_id)
);

CREATE INDEX idx_fpa_department_classifications_classification
  ON fpa_department_classifications (classification_id) WHERE is_active;

COMMENT ON TABLE fpa_department_classifications IS
  'C1: clasificaciones que el Chart of Accounts le da a cada departamento de FP&A (centro de costos). El área ve en la captura las de sus departamentos; una clasificación sin filas la ven todas. La carga fpa:catalogo desde scripts/data/fpa-coa.json. Nunca se borra una fila: se da de baja (is_active = false).';

-- -----------------------------------------------------------------------------
-- Permisos, como las demás tablas fpa_ de catálogo: sin DELETE. En dev, los
-- default privileges le dan arwd a abent3t_app en toda tabla nueva: se revoca
-- de forma explícita, para que dev se comporte como prod.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON fpa_department_classifications TO abent3t_app;
REVOKE DELETE, TRUNCATE ON fpa_department_classifications FROM abent3t_app;

COMMIT;
