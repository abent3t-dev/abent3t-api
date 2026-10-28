-- =============================================================================
-- 0022_fpa_versiones.sql — FP&A B2: parámetros de la versión con visto bueno
--
-- Reunión del 2026-10-26 (documentation/FPA.md, "Reunión del 26-oct", y
-- documentation/TAREAS_FPA_2026-10-26.md, B2): Laura fija cada año el tipo de
-- cambio y la inflación con las proyecciones de Santander y David da el visto
-- bueno en la plataforma, para que quede trazable con qué parámetros se calcula
-- el presupuesto de todas las áreas.
--
--   * B2  fpa_versions += params_source (de dónde salen los parámetros, p. ej.
--         "Proyecciones Santander, sep-2026"); quién y cuándo los cambió por
--         última vez (params_updated_*), y quién y cuándo dio el visto bueno
--         (params_approved_*). Cambiar un parámetro quita el visto bueno; abrir
--         la versión a captura lo exige (lo valida el service).
--   * B2  fpa_version_events: historial de la versión, de solo inserción:
--         creada, parámetros cambiados (con el antes y el después), visto bueno
--         (con la foto de los parámetros), abierta, regresada a preparación,
--         cerrada y reabierta.
--   * B4  fpa_budget_lines += updated_by: quién cambió la línea por última vez
--         (en un área capturan varias personas).
--
-- Aditiva y sin datos: las columnas nuevas quedan vacías en lo que ya existe y
-- ninguna regla nueva de la base depende del estado de la versión. La B-26 que
-- Laura y Liliana prueban en prod desde el 2026-10-27 sigue en captura, sin
-- visto bueno y sin historial previo; sus presupuestos y líneas no se tocan.
--
-- Despliegue: en el servidor B ANTES del rebuild que incluya B2 (el cliente de
-- Prisma de B2 ya trae estas columnas). Rollback: el código anterior no las lee;
-- la migración se puede quedar. Si una tabla está ocupada, espera hasta 5 s y
-- falla sin cambiar nada (lock_timeout): se vuelve a correr.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- B2 — Fuente de los parámetros, último cambio y visto bueno
-- -----------------------------------------------------------------------------
ALTER TABLE fpa_versions
  ADD COLUMN params_source      varchar(200),
  ADD COLUMN params_updated_by  uuid REFERENCES profiles(id),
  ADD COLUMN params_updated_at  timestamptz,
  ADD COLUMN params_approved_by uuid REFERENCES profiles(id),
  ADD COLUMN params_approved_at timestamptz;

ALTER TABLE fpa_versions
  ADD CONSTRAINT ck_fpa_versions_params_source CHECK (
    params_source IS NULL
    OR (btrim(params_source) <> '' AND params_source = btrim(params_source))),
  -- El visto bueno siempre dice quién y cuándo
  ADD CONSTRAINT ck_fpa_versions_params_approved
    CHECK ((params_approved_by IS NULL) = (params_approved_at IS NULL)),
  -- Un cambio sin persona es de un script (carga inicial), pero siempre lleva fecha
  ADD CONSTRAINT ck_fpa_versions_params_updated
    CHECK (params_updated_by IS NULL OR params_updated_at IS NOT NULL),
  -- Cuatro ojos: quien hizo el último cambio no da el visto bueno (lo valida
  -- el service; esto es el respaldo)
  ADD CONSTRAINT ck_fpa_versions_params_four_eyes CHECK (
    params_approved_by IS NULL OR params_updated_by IS NULL
    OR params_approved_by <> params_updated_by);

COMMENT ON COLUMN fpa_versions.status IS
  'A2/B2: preparacion (planeación fija los parámetros; las áreas no la ven) | captura (abierta al flujo) | cerrada (todo de solo lectura). Abrir a captura exige el visto bueno de planeación y los parámetros que usan sus líneas: la inflación, el tipo de cambio de cada moneda y las cuatro tarifas de viaje. Los parámetros solo cambian en preparación; para corregirlos, la versión regresa de captura a preparación solo mientras ningún presupuesto se haya enviado (el candado; lo valida el service): los montos se calculan al leer y lo enviado no se debe mover.';

COMMENT ON COLUMN fpa_versions.params_source IS
  'B2: de dónde salen el tipo de cambio, la inflación y las tarifas de la versión (p. ej. "Proyecciones Santander, sep-2026"; reunión del 26-oct, 15:05–16:39). Es parte de los parámetros: cambiarla quita el visto bueno. NULL = sin dato.';
COMMENT ON COLUMN fpa_versions.params_updated_by IS
  'B2: quién cambió los parámetros por última vez (inflación, fuente, tipos de cambio o tarifas). Quien los cambió no les da el visto bueno. NULL con params_updated_at = un script (carga inicial).';
COMMENT ON COLUMN fpa_versions.params_updated_at IS
  'B2: cuándo cambiaron los parámetros por última vez. NULL = nunca por pantalla.';
COMMENT ON COLUMN fpa_versions.params_approved_by IS
  'B2: quién dio el visto bueno a los parámetros (el firmante de planeación: David; reunión del 26-oct, 16:39–18:41). Un cambio de parámetros lo regresa a NULL. Abrir la versión a captura lo exige (service).';
COMMENT ON COLUMN fpa_versions.params_approved_at IS
  'B2: cuándo se dio el visto bueno a los parámetros. NULL = sin visto bueno.';

-- -----------------------------------------------------------------------------
-- B2 — Historial de la versión (solo inserción)
-- -----------------------------------------------------------------------------
CREATE TABLE fpa_version_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id       uuid NOT NULL REFERENCES fpa_versions(id),
  action           varchar(20) NOT NULL
    CONSTRAINT ck_fpa_version_events_action CHECK (action IN
      ('creada', 'parametros', 'visto_bueno', 'abierta', 'regresada',
       'cerrada', 'reabierta')),
  from_status      varchar(15),
  to_status        varchar(15),
  detail           jsonb,
  comment          text,
  actor_profile_id uuid NOT NULL REFERENCES profiles(id),
  actor_role       varchar(50),
  acting_as        varchar(12) NOT NULL
    CONSTRAINT ck_fpa_version_events_acting_as CHECK (acting_as IN
      ('titular', 'suplente', 'rol', 'super_admin')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Solo se guardan pasos posibles: los cambios de estado dicen de dónde y a
  -- dónde; los parámetros y el visto bueno no cambian el estado (COALESCE: un
  -- NULL no debe dejar pasar el CHECK)
  CONSTRAINT ck_fpa_version_events_transition CHECK (COALESCE(
       (action = 'creada'
        AND from_status IS NULL AND to_status = 'preparacion')
    OR (action IN ('parametros', 'visto_bueno')
        AND from_status IS NULL AND to_status IS NULL)
    OR (action = 'abierta'
        AND from_status = 'preparacion' AND to_status = 'captura')
    OR (action = 'regresada'
        AND from_status = 'captura' AND to_status = 'preparacion')
    OR (action = 'cerrada'
        AND from_status = 'captura' AND to_status = 'cerrada')
    OR (action = 'reabierta'
        AND from_status = 'cerrada' AND to_status = 'captura'),
    false)),
  -- Reabrir una versión cerrada SIEMPRE con comentario (el DTO pide 10 caracteres)
  CONSTRAINT ck_fpa_version_events_comment
    CHECK (action <> 'reabierta' OR btrim(coalesce(comment, '')) <> ''),
  -- El cambio de parámetros guarda el antes y el después, y el visto bueno, la
  -- foto de lo que se aprobó: siempre un objeto JSON (no vale el 'null' de
  -- Prisma.JsonNull)
  CONSTRAINT ck_fpa_version_events_detail CHECK (
        (detail IS NULL OR jsonb_typeof(detail) = 'object')
    AND (action NOT IN ('parametros', 'visto_bueno') OR detail IS NOT NULL))
);

CREATE INDEX idx_fpa_version_events_version
  ON fpa_version_events (version_id, created_at);

COMMENT ON TABLE fpa_version_events IS
  'B2: historial de una versión: creada, parámetros cambiados, visto bueno, abierta a captura, regresada a preparación, cerrada y reabierta, con quién, cuándo y con qué derecho. Solo inserción: la app no tiene UPDATE ni DELETE. En una transacción, el service bloquea la fila de la versión (SELECT … FOR UPDATE), revisa el estado con lo que hay en la base, la cambia e inserta el evento.';
COMMENT ON COLUMN fpa_version_events.detail IS
  'B2: parametros = {antes, despues, cambios, visto_bueno_retirado}; visto_bueno = {parametros: foto, hash}; creada = {copia_de} si se copiaron los parámetros de otra versión; abierta = {presupuestos_creados}; reabierta = {presupuestos_creados} si se crearon los de áreas nuevas. Con una clave schema para leer detalles viejos.';
COMMENT ON COLUMN fpa_version_events.actor_role IS
  'B2: rol del módulo fpa que le dio el derecho a actuar (fpa_planeacion o super_admin), como fpa_budget_events.actor_role.';
COMMENT ON COLUMN fpa_version_events.acting_as IS
  'B2: con qué derecho actuó: titular o suplente (firmante de planeación registrado en fpa_assignments, para el visto bueno), rol (planeación sin firmantes registrados, o cualquier otra acción) o super_admin (solo soporte).';

-- -----------------------------------------------------------------------------
-- B4 — Quién cambió la línea por última vez
-- -----------------------------------------------------------------------------
ALTER TABLE fpa_budget_lines
  ADD COLUMN updated_by uuid REFERENCES profiles(id);

COMMENT ON COLUMN fpa_budget_lines.updated_by IS
  'B4: quién cambió o dio de baja la línea por última vez (en un área capturan varias personas; reunión del 26-oct, 10:00). NULL = nadie la ha cambiado desde que se creó (created_by dice quién la creó).';

-- -----------------------------------------------------------------------------
-- Permisos. El historial es de solo inserción. Las columnas nuevas de
-- fpa_versions y fpa_budget_lines quedan cubiertas por los GRANT de tabla de
-- 0021. En dev, los default privileges le dan arwd a abent3t_app en toda tabla
-- nueva: se revoca de forma explícita, para que dev se comporte como prod.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT ON fpa_version_events TO abent3t_app;
REVOKE UPDATE, DELETE, TRUNCATE ON fpa_version_events FROM abent3t_app;

COMMIT;
