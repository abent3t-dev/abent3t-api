-- =============================================================================
-- 0021_fpa_presupuesto.sql — FP&A fase 1: presupuesto por área y su flujo (A2)
--
-- Módulo nuevo (reunión del 2026-10-19; documentation/FPA.md, secciones
-- "Formato único de captura" y "Diseño"). Todo lleva el prefijo fpa_: budgets
-- y periods son de CAPACITACIÓN y no se tocan, y nada cuelga de contabilidad
-- (maqueta) ni de sus roles ni de los de compras. Aditiva; NO siembra datos:
-- áreas, personas, catálogos, versiones, tipos de cambio y tarifas se cargan
-- por pantalla o por Excel (prod arrancó sin el seed de dev).
--
--   * A2  user_module += 'fpa'; user_role += fpa_area, fpa_planeacion y
--         fpa_cfo. Un valor de enum NO se puede borrar: Alex aprobó estos
--         nombres el 2026-10-19 (revisión de A2). Nada de esta
--         migración usa los valores nuevos (como 0010 y 0011), así que van en
--         la misma transacción.
--   * A2  Un rol activo por módulo: el rol solo da la entrada y el alcance.
--         Quién captura, aprueba o consulta cada área, y quién firma
--         planeación y CFO, vive en fpa_assignments (titular o suplente).
--   * A2  fpa_areas (con su departamento propio), fpa_departments (con su
--         centro de costos de SAP), fpa_categories y fpa_classifications:
--         catálogos de FP&A. Toda línea lleva departamento.
--   * A2  fpa_versions con su inflación, fpa_exchange_rates y
--         fpa_travel_rates: los fija FP&A por versión, no el área.
--   * A2  fpa_budgets (área × versión, estado del flujo área › planeación ›
--         CFO) y fpa_budget_events (historial de solo inserción, con la foto
--         de lo enviado en cada ronda).
--   * A2  fpa_line_keys (identidad de la línea entre versiones, con folio),
--         fpa_budget_lines, fpa_budget_line_months y fpa_line_comments. Se
--         guarda SOLO lo capturado: los montos en pesos, los totales y el
--         consolidado los calcula el service (fpa-calc).
--   * Estados como varchar + CHECK ck_ (patrón 0018), no enums. Prisma no
--     modela los CHECK ni los únicos parciales: el service maneja P2002.
--   * Permisos: DELETE solo en los meses. En dev, los default privileges dan
--     DELETE en toda tabla nueva: aquí se revoca explícito en las demás.
--
-- Despliegue: A3 se sube a main, así que en prod esta migración va en el
-- servidor B ANTES del primer rebuild que incluya código de FP&A, aunque el
-- módulo se lance después. Los roles fpa se asignan cuando se lance.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- A2 — Módulo y roles (aprobados por Alex el 2026-10-19; no se pueden quitar)
-- -----------------------------------------------------------------------------
ALTER TYPE user_module ADD VALUE IF NOT EXISTS 'fpa';
ALTER TYPE user_role   ADD VALUE IF NOT EXISTS 'fpa_area';
ALTER TYPE user_role   ADD VALUE IF NOT EXISTS 'fpa_planeacion';
ALTER TYPE user_role   ADD VALUE IF NOT EXISTS 'fpa_cfo';

-- -----------------------------------------------------------------------------
-- A2 — Áreas que cargan presupuesto y departamentos a los que se carga
-- -----------------------------------------------------------------------------
CREATE TABLE fpa_areas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          varchar(120) NOT NULL,
  -- FK a fpa_departments, abajo (las dos tablas se apuntan entre sí)
  department_id uuid,
  sort_order    smallint NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_fpa_areas_name UNIQUE (name),
  -- Sin nombres vacíos ni con espacios de más ('Compras ' no es 'Compras')
  CONSTRAINT ck_fpa_areas_name CHECK (btrim(name) <> '' AND name = btrim(name))
);

COMMENT ON TABLE fpa_areas IS
  'A2: áreas que cargan presupuesto (5 o 6; reunión 50:49): cada una captura un presupuesto por versión. No es departments (capacitación). Quién captura y quién aprueba vive en fpa_assignments. Darla de baja solo la saca de lo que viene (no recibe presupuesto al abrir una versión ni responsables nuevos): el service no lo permite mientras tenga presupuestos vivos en una versión en preparación o en captura, y en las versiones cerradas su presupuesto sigue contando.';
COMMENT ON COLUMN fpa_areas.department_id IS
  'A2: departamento propio del área: el que toma una línea por omisión (A1: el departamento es obligatorio y, por omisión, el del área que captura). El service lo crea con el mismo nombre al dar de alta el área. NULL = aún sin departamento propio: sus líneas piden uno explícito.';

CREATE TABLE fpa_departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(120) NOT NULL,
  area_id     uuid REFERENCES fpa_areas(id),
  cost_center varchar(30),
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_fpa_departments_name UNIQUE (name),
  CONSTRAINT ck_fpa_departments_name
    CHECK (btrim(name) <> '' AND name = btrim(name))
);

ALTER TABLE fpa_areas ADD CONSTRAINT fpa_areas_department_id_fkey
  FOREIGN KEY (department_id) REFERENCES fpa_departments(id);

CREATE INDEX idx_fpa_departments_area ON fpa_departments (area_id);
-- Un centro de costos de SAP pertenece a un solo departamento vivo
CREATE UNIQUE INDEX uq_fpa_departments_cost_center
  ON fpa_departments (cost_center) WHERE cost_center IS NOT NULL AND is_active;

COMMENT ON TABLE fpa_departments IS
  'A2: departamentos a los que se carga el gasto (¿los 12 de la reunión?, pregunta 28). Toda línea lleva uno: el propio del área que captura (fpa_areas.department_id) u otro cuando un área captura para otra (RH carga RRHH, SSGG e IT). Su centro de costos es la llave del cruce con el real.';
COMMENT ON COLUMN fpa_departments.area_id IS
  'A2: área que normalmente lo captura (RH para SSGG e IT). NULL = cualquiera.';
COMMENT ON COLUMN fpa_departments.cost_center IS
  'A2: centro de costos de SAP (CostingCode, p. ej. GSGAD009), por confirmar con Laura (pregunta 28). Llave del cruce con el real en la fase 2. NULL = sin liga.';

-- -----------------------------------------------------------------------------
-- A2 — Quién hace qué: captura y aprobación de cada área, consulta, y los
-- firmantes de planeación y CFO. Nunca se borra una fila: se revoca, como en
-- user_roles (is_active = false, revoked_at y revoked_by).
-- -----------------------------------------------------------------------------
CREATE TABLE fpa_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duty         varchar(12) NOT NULL
    CONSTRAINT ck_fpa_assignments_duty CHECK (duty IN
      ('captura', 'aprobacion', 'consulta', 'planeacion', 'cfo')),
  area_id      uuid REFERENCES fpa_areas(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  is_alternate boolean NOT NULL DEFAULT false,
  notes        varchar(500),
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES profiles(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES profiles(id),
  -- Captura y aprobación son de un área; planeación y CFO, de todas; la
  -- consulta puede ser de un área o general (area_id NULL)
  CONSTRAINT ck_fpa_assignments_area CHECK (
       (duty IN ('captura', 'aprobacion') AND area_id IS NOT NULL)
    OR (duty IN ('planeacion', 'cfo') AND area_id IS NULL)
    OR duty = 'consulta'),
  CONSTRAINT ck_fpa_assignments_consulta
    CHECK (duty <> 'consulta' OR NOT is_alternate),
  CONSTRAINT ck_fpa_assignments_revoked CHECK (
    is_active = (revoked_at IS NULL)
    AND (revoked_at IS NULL) = (revoked_by IS NULL))
);

-- Una sola persona titular captura y una sola aprueba en cada área (50:49)
CREATE UNIQUE INDEX uq_fpa_assignments_titular
  ON fpa_assignments (area_id, duty)
  WHERE is_active AND NOT is_alternate AND duty IN ('captura', 'aprobacion');
-- Una función por persona y área: quien captura un área no la aprueba
CREATE UNIQUE INDEX uq_fpa_assignments_area_person
  ON fpa_assignments (area_id, profile_id)
  WHERE is_active AND area_id IS NOT NULL;
-- Sin filas repetidas en las funciones generales
CREATE UNIQUE INDEX uq_fpa_assignments_general
  ON fpa_assignments (duty, profile_id)
  WHERE is_active AND area_id IS NULL;
CREATE INDEX idx_fpa_assignments_profile
  ON fpa_assignments (profile_id) WHERE is_active;

COMMENT ON TABLE fpa_assignments IS
  'A2: quién hace qué en FP&A: captura y aprobación de cada área, consulta (de un área o de todas) y firmantes de planeación y CFO. No cabe en user_roles (un rol activo por módulo). El service exige un rol fpa activo: planeacion pide fpa_planeacion; cfo pide fpa_cfo; captura, aprobacion y consulta, cualquier rol fpa.';
COMMENT ON COLUMN fpa_assignments.duty IS
  'A2: captura | aprobacion (paso del área) | consulta (solo lectura) | planeacion | cfo. Si planeacion o cfo no tienen filas activas, firma cualquiera con el rol del paso; con filas, solo esas personas (patrón rol y/o persona de committee_approval_levels, 0007).';
COMMENT ON COLUMN fpa_assignments.is_alternate IS
  'A2: suplente del titular: puede actuar igual que él y el historial guarda que actuó como suplente; los avisos van al titular. La reunión pidió una sola persona por área (50:49); Ingrid comentó que, si ella no está, Jorge o Diana pueden capturar (52:10).';
COMMENT ON COLUMN fpa_assignments.revoked_at IS
  'A2: cuándo se revocó (is_active = false; revoked_by dice quién). Así queda el historial de quién capturó o aprobó cada área, como en user_roles.';

-- -----------------------------------------------------------------------------
-- A2 — Catálogo: categorías y clasificaciones (los mantiene FP&A)
-- -----------------------------------------------------------------------------
CREATE TABLE fpa_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       varchar(120) NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_fpa_categories_name UNIQUE (name),
  CONSTRAINT ck_fpa_categories_name
    CHECK (btrim(name) <> '' AND name = btrim(name))
);

CREATE TABLE fpa_classifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id     uuid NOT NULL REFERENCES fpa_categories(id),
  name            varchar(120) NOT NULL,
  allows_negative boolean NOT NULL DEFAULT false,
  sort_order      smallint NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_fpa_classifications_name UNIQUE (category_id, name),
  CONSTRAINT ck_fpa_classifications_name
    CHECK (btrim(name) <> '' AND name = btrim(name))
);

COMMENT ON TABLE fpa_categories IS
  'A2: categorías de gasto del formato único (Servicios Profesionales, Viajes, Eventos, Capacitación, Beneficios…). sort_order = orden del reporte de Laura. Probable nivel 2 del Chart of Accounts (pregunta 33). El nombre no admite vacíos ni espacios de más; mayúsculas y acentos (Comunicaciónes, ServiciosProfesionales) los normalizan el service y el importador.';
COMMENT ON TABLE fpa_classifications IS
  'A2: clasificaciones de cada categoría (lista que depende de la categoría). La línea guarda la clasificación y la categoría sale de aquí; un viaje se carga a Viajes o a Capacitación por su clasificación. Probable nivel 3 del Chart of Accounts (pregunta 33). Con líneas, no se renombra ni se mueve a otra categoría (cambiaría los reportes de lo aprobado): se desactiva y se crea otra; lo valida el service.';
COMMENT ON COLUMN fpa_classifications.allows_negative IS
  'A2: true = acepta montos negativos (descuentos y ajustes D-5; pregunta 18). Lo valida el service; en las demás, un monto o precio negativo se rechaza.';

-- -----------------------------------------------------------------------------
-- A2 — Ejercicio y versión, con su inflación, tipos de cambio y tarifas
-- -----------------------------------------------------------------------------
CREATE TABLE fpa_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year     smallint NOT NULL
    CONSTRAINT ck_fpa_versions_year CHECK (fiscal_year BETWEEN 2020 AND 2100),
  kind            varchar(15) NOT NULL
    CONSTRAINT ck_fpa_versions_kind
      CHECK (kind IN ('presupuesto', 'forecast', 'comparacion')),
  code            varchar(20) NOT NULL,
  name            varchar(120) NOT NULL,
  cutoff_month    smallint
    CONSTRAINT ck_fpa_versions_cutoff_month
      CHECK (cutoff_month BETWEEN 1 AND 11),
  base_version_id uuid REFERENCES fpa_versions(id),
  inflation_pct   numeric(6,3)
    CONSTRAINT ck_fpa_versions_inflation
      CHECK (inflation_pct >= 0 AND inflation_pct < 100),
  status          varchar(15) NOT NULL DEFAULT 'preparacion'
    CONSTRAINT ck_fpa_versions_status
      CHECK (status IN ('preparacion', 'captura', 'cerrada')),
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_fpa_versions_code UNIQUE (code),
  CONSTRAINT ck_fpa_versions_code
    CHECK (btrim(code) <> '' AND code = btrim(code)),
  CONSTRAINT ck_fpa_versions_name
    CHECK (btrim(name) <> '' AND name = btrim(name)),
  -- Solo un forecast lleva mes de corte, y siempre lo lleva
  CONSTRAINT ck_fpa_versions_cutoff
    CHECK ((kind = 'forecast') = (cutoff_month IS NOT NULL)),
  CONSTRAINT ck_fpa_versions_base
    CHECK (base_version_id IS NULL OR base_version_id <> id)
);

CREATE INDEX idx_fpa_versions_year ON fpa_versions (fiscal_year);

COMMENT ON TABLE fpa_versions IS
  'A2: versión de un ejercicio (fiscal_year; el ejercicio no lleva tabla aparte). presupuesto: B-26, B-27; forecast: F2-26, con mes de corte; comparacion: P-27, P-28 e históricos, sin presupuestos ni flujo (lo valida el service; su carga se define con Laura, preguntas 1 y 5). Un forecast o el presupuesto siguiente se crean copiando las líneas de base_version_id con su misma llave; la versión original no se toca. Un forecast copia de su base del mismo ejercicio la inflación, los tipos de cambio y las tarifas; el presupuesto del ejercicio siguiente fija los suyos.';
COMMENT ON COLUMN fpa_versions.code IS
  'A2: clave con la que la conoce el cliente: B-26, F2-26, B-27, P-27.';
COMMENT ON COLUMN fpa_versions.cutoff_month IS
  'A2: forecast: último mes con real (8 = real ene–ago). Esos meses no los captura el área: salen del real (fase 2; mientras tanto, la versión muestra solo los meses abiertos y el service rechaza los meses hasta el corte). NULL en presupuesto y comparacion.';
COMMENT ON COLUMN fpa_versions.base_version_id IS
  'A2: versión de la que se copiaron las líneas (mismo line_key_id). NULL = se capturó desde cero.';
COMMENT ON COLUMN fpa_versions.inflation_pct IS
  'A2: inflación de la versión en % (4.000 en el B-26; 3.700 en 2027). Factor del índice inflacion = 1 + inflation_pct/100. NULL = FP&A no la ha fijado: las líneas con inflación salen "No disponible", nunca con factor 1. Un forecast hereda la de su base del mismo ejercicio.';
COMMENT ON COLUMN fpa_versions.status IS
  'A2: preparacion (FP&A fija parámetros; las áreas no la ven) | captura (abierta al flujo) | cerrada (todo de solo lectura). Abrir a captura exige los parámetros que usan sus líneas: la inflación si alguna la usa, el tipo de cambio de cada moneda y las tarifas de cada tipo de viaje y de viajero. Los tipos de cambio, la inflación y las tarifas solo cambian mientras ningún presupuesto de la versión esté enviado o aprobado (lo valida el service): los montos se calculan al leer y lo aprobado no se debe mover.';

CREATE TABLE fpa_exchange_rates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES fpa_versions(id),
  currency   varchar(3) NOT NULL
    CONSTRAINT ck_fpa_exchange_rates_currency
      CHECK (currency ~ '^[A-Z]{3}$' AND currency NOT IN ('MXN', 'MXP')),
  rate_mxn   numeric(18,6) NOT NULL
    CONSTRAINT ck_fpa_exchange_rates_rate CHECK (rate_mxn > 0),
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_fpa_exchange_rates UNIQUE (version_id, currency)
);

COMMENT ON TABLE fpa_exchange_rates IS
  'A2: tipo de cambio de cada moneda en la versión; lo fija FP&A, no el área. MXN vale 1 y no se guarda. Las monedas válidas de la versión son MXN y las activas de esta tabla (ISO de 3 letras; no se copia suppliers.currency, que trae ## y MXP). Una fila por moneda y versión: la baja es is_active = false y el PUT de tipos de cambio hace upsert por (versión, moneda), así que dar de alta otra vez una moneda reactiva su fila. Sin tipo de cambio activo, las líneas en esa moneda salen "No disponible".';
COMMENT ON COLUMN fpa_exchange_rates.rate_mxn IS
  'A2: pesos por una unidad de la moneda (USD 20 y EUR 22 en el B-26).';

CREATE TABLE fpa_travel_rates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id        uuid NOT NULL REFERENCES fpa_versions(id),
  trip_type         varchar(15) NOT NULL
    CONSTRAINT ck_fpa_travel_rates_trip_type
      CHECK (trip_type IN ('nacional', 'internacional')),
  traveler_type     varchar(15) NOT NULL
    CONSTRAINT ck_fpa_travel_rates_traveler_type
      CHECK (traveler_type IN ('colaborador', 'director')),
  flight_per_person numeric(15,2) NOT NULL,
  hotel_per_night   numeric(15,2) NOT NULL,
  transport_per_day numeric(15,2) NOT NULL,
  meals_per_day     numeric(15,2) NOT NULL,
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_fpa_travel_rates UNIQUE (version_id, trip_type, traveler_type),
  CONSTRAINT ck_fpa_travel_rates_amounts
    CHECK (flight_per_person >= 0 AND hotel_per_night >= 0
           AND transport_per_day >= 0 AND meals_per_day >= 0)
);

COMMENT ON TABLE fpa_travel_rates IS
  'A2: tarifas de viaje de la versión en pesos (hoja ''2'' de los B-26; pregunta 22), una fila por tipo de viaje y de viajero. Vuelo × personas; hotel × noches × personas; alimentos × (noches + 1) × personas; transporte × (noches + 1), una vez por viaje y sin personas, con la tarifa de director si va al menos un director y si no, la de colaborador (hoy valen lo mismo). Un viaje sin tarifa activa para alguno de sus tipos de viajero sale "No disponible" (nunca 0) y su presupuesto no se puede enviar. La baja es is_active = false; el PUT de tarifas hace upsert y reactiva la fila. La renta de vehículo aún no tiene tarifa (pregunta 23): si se define, es una columna nueva.';

-- -----------------------------------------------------------------------------
-- A2 — Presupuesto de un área en una versión: la unidad que se aprueba
-- -----------------------------------------------------------------------------
CREATE TABLE fpa_budgets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id    uuid NOT NULL REFERENCES fpa_versions(id),
  area_id       uuid NOT NULL REFERENCES fpa_areas(id),
  status        varchar(20) NOT NULL DEFAULT 'borrador'
    CONSTRAINT ck_fpa_budgets_status CHECK (status IN ('borrador', 'enviado',
      'aprobado_area', 'aprobado_planeacion', 'aprobado_cfo', 'devuelto')),
  current_round smallint NOT NULL DEFAULT 0,
  submitted_at  timestamptz,
  approved_at   timestamptz,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Destino de la FK compuesta de fpa_budget_lines (línea y presupuesto de
  -- la misma versión)
  CONSTRAINT uq_fpa_budgets_id_version UNIQUE (id, version_id),
  -- Fuera de borrador siempre hubo al menos un envío
  CONSTRAINT ck_fpa_budgets_round CHECK (
    current_round >= 0 AND (status = 'borrador' OR current_round >= 1)),
  CONSTRAINT ck_fpa_budgets_submitted
    CHECK ((current_round = 0) = (submitted_at IS NULL)),
  CONSTRAINT ck_fpa_budgets_approved
    CHECK ((status = 'aprobado_cfo') = (approved_at IS NOT NULL))
);

-- Uno vigente por área y versión (patrón budgets_department_period_unique)
CREATE UNIQUE INDEX uq_fpa_budgets_version_area
  ON fpa_budgets (version_id, area_id) WHERE is_active;
CREATE INDEX idx_fpa_budgets_version_status ON fpa_budgets (version_id, status);
CREATE INDEX idx_fpa_budgets_area ON fpa_budgets (area_id);

COMMENT ON TABLE fpa_budgets IS
  'A2: presupuesto de un área en una versión, la unidad del flujo área › planeación › CFO. No confundir con budgets, que es el de capacitación. Sus totales no se guardan: los calcula el service. Darlo de baja (is_active = false) da de baja también sus líneas, en la misma transacción del service, para que sus llaves queden libres en la versión. Una versión de comparación no lleva presupuestos.';
COMMENT ON COLUMN fpa_budgets.status IS
  'A2: borrador | enviado (turno del aprobador del área) | aprobado_area (turno de planeación) | aprobado_planeacion (turno del CFO) | aprobado_cfo (final) | devuelto (rechazado en cualquier paso o reabierto: regresa a captura con comentario). Solo borrador y devuelto se editan; lo aplica el service en toda escritura.';
COMMENT ON COLUMN fpa_budgets.current_round IS
  'A2: número de envíos (ronda). 0 = nunca enviado; cada envío abre la ronda siguiente y el flujo empieza otra vez en el área. Se llama ronda para no chocar con las versiones del ejercicio.';
COMMENT ON COLUMN fpa_budgets.approved_at IS
  'A2: aprobación del CFO. Solo con status aprobado_cfo; reabrir lo regresa a NULL.';

-- -----------------------------------------------------------------------------
-- A2 — Historial del flujo (solo inserción), con la foto de cada envío
-- -----------------------------------------------------------------------------
CREATE TABLE fpa_budget_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id        uuid NOT NULL REFERENCES fpa_budgets(id),
  round            smallint NOT NULL
    CONSTRAINT ck_fpa_budget_events_round CHECK (round >= 1),
  action           varchar(12) NOT NULL
    CONSTRAINT ck_fpa_budget_events_action CHECK (action IN
      ('enviado', 'aprobado', 'rechazado', 'retirado', 'reabierto')),
  step             varchar(12)
    CONSTRAINT ck_fpa_budget_events_step
      CHECK (step IN ('area', 'planeacion', 'cfo')),
  from_status      varchar(20) NOT NULL,
  to_status        varchar(20) NOT NULL,
  comment          text,
  actor_profile_id uuid NOT NULL REFERENCES profiles(id),
  actor_role       varchar(50),
  acting_as        varchar(12) NOT NULL
    CONSTRAINT ck_fpa_budget_events_acting_as CHECK (acting_as IN
      ('titular', 'suplente', 'rol', 'super_admin')),
  snapshot         jsonb,
  total_mxn        numeric(15,2),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Aprobar y rechazar llevan el paso que deciden; lo demás, no
  CONSTRAINT ck_fpa_budget_events_step_needed
    CHECK ((action IN ('aprobado', 'rechazado')) = (step IS NOT NULL)),
  -- La máquina de estados: solo se guardan pasos posibles (COALESCE: un
  -- NULL no debe dejar pasar el CHECK)
  CONSTRAINT ck_fpa_budget_events_transition CHECK (COALESCE(
       (action = 'enviado'
        AND from_status IN ('borrador', 'devuelto') AND to_status = 'enviado')
    OR (action IN ('aprobado', 'rechazado')
        AND ((step = 'area'       AND from_status = 'enviado')
          OR (step = 'planeacion' AND from_status = 'aprobado_area')
          OR (step = 'cfo'        AND from_status = 'aprobado_planeacion'))
        AND to_status = CASE WHEN action = 'rechazado' THEN 'devuelto'
                             ELSE 'aprobado_' || step END)
    OR (action = 'retirado'
        AND from_status = 'enviado' AND to_status = 'borrador')
    OR (action = 'reabierto'
        AND from_status = 'aprobado_cfo' AND to_status = 'devuelto'),
    false)),
  -- Rechazar o reabrir SIEMPRE con comentario (el DTO pide 10 caracteres)
  CONSTRAINT ck_fpa_budget_events_comment
    CHECK (action NOT IN ('rechazado', 'reabierto')
           OR btrim(coalesce(comment, '')) <> ''),
  -- Cada envío, y solo un envío, guarda la foto de lo enviado (un objeto
  -- JSON: no vale el 'null' de Prisma.JsonNull) y su total
  CONSTRAINT ck_fpa_budget_events_snapshot CHECK (
        ((action = 'enviado') = (snapshot IS NOT NULL))
    AND ((snapshot IS NULL) = (total_mxn IS NULL))
    AND (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'))
);

-- Una decisión por paso y ronda, y un envío por ronda. El service hace primero
-- el UPDATE condicional del presupuesto (409 si otro ya lo cambió) y después
-- el INSERT; un choque cuenta como "ya hecho" solo si el evento que existe es
-- del mismo actor y la misma acción
CREATE UNIQUE INDEX uq_fpa_budget_events_decision
  ON fpa_budget_events (budget_id, round, step)
  WHERE action IN ('aprobado', 'rechazado');
CREATE UNIQUE INDEX uq_fpa_budget_events_submit
  ON fpa_budget_events (budget_id, round) WHERE action = 'enviado';
CREATE INDEX idx_fpa_budget_events_budget
  ON fpa_budget_events (budget_id, created_at);

COMMENT ON TABLE fpa_budget_events IS
  'A2: historial del flujo de un presupuesto: envíos, firmas, rechazos, retiros y reaperturas, con su comentario. Solo inserción: la app no tiene UPDATE ni DELETE. El service valida el turno (fpa_assignments y roles) y, en una transacción, hace primero el UPDATE condicional del status del presupuesto (estado y ronda esperados; 409 si otro ya lo cambió) y después inserta el evento. Si choca con un evento que ya existe, cuenta como ya hecho solo si es del mismo actor y la misma acción.';
COMMENT ON COLUMN fpa_budget_events.round IS
  'A2: ronda del presupuesto (fpa_budgets.current_round) en que ocurrió.';
COMMENT ON COLUMN fpa_budget_events.step IS
  'A2: paso que aprueba o rechaza: area | planeacion | cfo. NULL en enviado, retirado y reabierto.';
COMMENT ON COLUMN fpa_budget_events.actor_role IS
  'A2: rol del módulo fpa que le dio el derecho a actuar (como audit_logs.user_role). Si la persona tiene dos roles fpa activos, el que corresponde al paso.';
COMMENT ON COLUMN fpa_budget_events.acting_as IS
  'A2: con qué derecho actuó: titular o suplente (fpa_assignments), rol (paso sin firmantes registrados, o planeación al reabrir) o super_admin (solo soporte).';
COMMENT ON COLUMN fpa_budget_events.snapshot IS
  'A2: foto de lo enviado en la ronda: el mismo detalle que devuelve el API (líneas, meses calculados, tipos de cambio, inflación y tarifas), con una clave schema para leer fotos viejas. Siempre un objeto JSON. Se guarda a propósito, como evidencia de lo que se aprobó aunque después se reabra, y para mostrar qué cambió entre rondas.';
COMMENT ON COLUMN fpa_budget_events.total_mxn IS
  'A2: total en pesos de la foto, copiado para listar rondas sin abrir el JSON. Un presupuesto con una línea "No disponible" no se envía: sin total no hay foto.';

-- -----------------------------------------------------------------------------
-- A2 — Identidad de la línea entre versiones, líneas, meses y comentarios
-- -----------------------------------------------------------------------------
CREATE TABLE fpa_line_keys (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number     integer GENERATED ALWAYS AS IDENTITY,
  origin     varchar(15) NOT NULL
    CONSTRAINT ck_fpa_line_keys_origin
      CHECK (origin IN ('captura', 'importacion', 'real')),
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_fpa_line_keys_number UNIQUE (number)
);

COMMENT ON TABLE fpa_line_keys IS
  'A2: identidad estable de una línea entre versiones (Identificador de línea, FPA.md §2.2). Copiar una versión conserva la llave; una línea nueva recibe una propia. Compara presupuesto, forecast y real por línea; el real de la fase 2 se asigna a la llave, no a una versión. No tiene área: una línea puede pasar de un área a otra.';
COMMENT ON COLUMN fpa_line_keys.number IS
  'A2: folio visible (L-000123) para la plantilla de Excel (reimportar sin duplicar) y para hablar de la línea con las áreas. Lo genera siempre la base (GENERATED ALWAYS): ni la app ni el importador lo escriben; el folio de un Excel solo sirve para encontrar su llave.';
COMMENT ON COLUMN fpa_line_keys.origin IS
  'A2: captura (alta en pantalla), importacion (Excel) o real (nació de un gasto sin línea, fase 2).';

CREATE TABLE fpa_budget_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id             uuid NOT NULL,
  version_id            uuid NOT NULL,
  line_key_id           uuid NOT NULL REFERENCES fpa_line_keys(id),
  sort_order            integer NOT NULL DEFAULT 0,
  department_id         uuid NOT NULL REFERENCES fpa_departments(id),
  classification_id     uuid NOT NULL REFERENCES fpa_classifications(id),
  concept               varchar(255) NOT NULL,
  justification         text,
  supplier_id           uuid REFERENCES suppliers(id),
  supplier_name         varchar(255),
  priority              varchar(15)
    CONSTRAINT ck_fpa_budget_lines_priority
      CHECK (priority IN ('contractual', 'necesario', 'deseable')),
  calc_method           varchar(15) NOT NULL
    CONSTRAINT ck_fpa_budget_lines_calc_method
      CHECK (calc_method IN ('precio_veces', 'monto_mes', 'viaje')),
  currency              varchar(3) NOT NULL
    CONSTRAINT ck_fpa_budget_lines_currency
      CHECK (currency ~ '^[A-Z]{3}$' AND currency <> 'MXP'),
  price_index           varchar(16) NOT NULL
    CONSTRAINT ck_fpa_budget_lines_price_index
      CHECK (price_index IN ('precio_acordado', 'inflacion')),
  unit_price            numeric(15,4),
  trip_type             varchar(15)
    CONSTRAINT ck_fpa_budget_lines_trip_type
      CHECK (trip_type IN ('nacional', 'internacional')),
  travelers_colaborador smallint
    CONSTRAINT ck_fpa_budget_lines_travelers_c
      CHECK (travelers_colaborador >= 0),
  travelers_director    smallint
    CONSTRAINT ck_fpa_budget_lines_travelers_d
      CHECK (travelers_director >= 0),
  nights                smallint
    CONSTRAINT ck_fpa_budget_lines_nights CHECK (nights >= 0),
  car_rental            boolean,
  contract_label        varchar(120),
  project_tag           varchar(60),
  outside_ebitda        boolean,
  spend_type            varchar(15)
    CONSTRAINT ck_fpa_budget_lines_spend_type
      CHECK (spend_type IN ('recurrente', 'extraordinario', 'inversion')),
  source_ref            varchar(120),
  is_active             boolean NOT NULL DEFAULT true,
  created_by            uuid REFERENCES profiles(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- La línea y su presupuesto son de la misma versión
  CONSTRAINT fpa_budget_lines_budget_version_fkey
    FOREIGN KEY (budget_id, version_id) REFERENCES fpa_budgets (id, version_id),
  CONSTRAINT ck_fpa_budget_lines_concept CHECK (btrim(concept) <> ''),
  -- Precio × veces lleva precio de la línea; las otras dos formas, no
  CONSTRAINT ck_fpa_budget_lines_price
    CHECK ((calc_method = 'precio_veces') = (unit_price IS NOT NULL)),
  -- Viaje: sus campos completos, en pesos y con precio acordado (las tarifas
  -- ya son de la versión); las demás formas no llevan campos de viaje
  CONSTRAINT ck_fpa_budget_lines_trip CHECK (
    (calc_method = 'viaje'
      AND trip_type IS NOT NULL AND nights IS NOT NULL
      AND car_rental IS NOT NULL
      AND travelers_colaborador IS NOT NULL AND travelers_director IS NOT NULL
      AND travelers_colaborador + travelers_director >= 1
      AND currency = 'MXN' AND price_index = 'precio_acordado')
    OR
    (calc_method <> 'viaje'
      AND trip_type IS NULL AND nights IS NULL AND car_rental IS NULL
      AND travelers_colaborador IS NULL AND travelers_director IS NULL)),
  -- Todo gasto que no es viaje lleva proveedor: del catálogo, OTROS u otro
  CONSTRAINT ck_fpa_budget_lines_supplier
    CHECK (calc_method = 'viaje' OR btrim(coalesce(supplier_name, '')) <> '')
);

CREATE INDEX idx_fpa_budget_lines_budget ON fpa_budget_lines (budget_id);
CREATE INDEX idx_fpa_budget_lines_line_key ON fpa_budget_lines (line_key_id);
CREATE INDEX idx_fpa_budget_lines_department
  ON fpa_budget_lines (department_id);
CREATE INDEX idx_fpa_budget_lines_classification
  ON fpa_budget_lines (classification_id);
CREATE INDEX idx_fpa_budget_lines_supplier ON fpa_budget_lines (supplier_id)
  WHERE supplier_id IS NOT NULL;
-- La misma llave, una sola vez entre las líneas vivas de una versión (aunque
-- cambie de área): el consolidado no cuenta dos veces
CREATE UNIQUE INDEX uq_fpa_budget_lines_version_key
  ON fpa_budget_lines (version_id, line_key_id) WHERE is_active;

COMMENT ON TABLE fpa_budget_lines IS
  'A2: líneas de gasto del formato único (FPA.md §2.2). Guarda solo lo capturado; el monto en moneda original y en pesos de cada mes, el total y el consolidado los calcula el service con la versión (tipo de cambio, inflación y tarifas). Nada calculado se persiste. Se edita solo con el presupuesto en borrador o devuelto y la versión en captura.';
COMMENT ON COLUMN fpa_budget_lines.version_id IS
  'A2: repite la versión del presupuesto (FK compuesta) para que una llave aparezca una sola vez por versión.';
COMMENT ON COLUMN fpa_budget_lines.department_id IS
  'A2: departamento al que se carga la línea, siempre (A1: obligatorio). Por omisión, el propio del área que captura (fpa_areas.department_id); otro cuando un área captura para otra: SSGG o IT en la captura de RH, o la capacitación de Compras que carga RH. Con él, la línea trae el centro de costos del cruce con el real.';
COMMENT ON COLUMN fpa_budget_lines.supplier_id IS
  'A2: proveedor del catálogo suppliers (espejo de SAP). NULL = OTROS o un proveedor que no está en el catálogo: NO se crea un proveedor genérico en suppliers.';
COMMENT ON COLUMN fpa_budget_lines.supplier_name IS
  'A2: copia del nombre del proveedor al guardar (el espejo de SAP cambia legal_name), u OTROS o el texto capturado si supplier_id es NULL. NULL solo en viajes.';
COMMENT ON COLUMN fpa_budget_lines.calc_method IS
  'A2: precio_veces = veces del mes × precio (el del mes o el de la línea); monto_mes = monto de cada mes; viaje = viajes del mes × costo del viaje con las tarifas de la versión. Se pide siempre, sin valor por omisión (reunión 35:00).';
COMMENT ON COLUMN fpa_budget_lines.currency IS
  'A2: ISO de 3 letras, sin valor por omisión (reunión 35:00). El service exige MXN o una moneda con tipo de cambio en la versión.';
COMMENT ON COLUMN fpa_budget_lines.price_index IS
  'A2: precio_acordado = factor 1 (precio de contrato); inflacion = 1 + fpa_versions.inflation_pct/100. Se pide siempre, sin valor por omisión. En viaje, siempre precio_acordado.';
COMMENT ON COLUMN fpa_budget_lines.unit_price IS
  'A2: precio sin IVA en la moneda de la línea, hasta 4 decimales. Solo en precio_veces.';
COMMENT ON COLUMN fpa_budget_lines.travelers_director IS
  'A2: viaje: personas de tipo director; travelers_colaborador, las de tipo colaborador. Ambas en la misma línea (pregunta 24); en un viaje de un solo tipo, la otra va en 0. Mientras se contesta la pregunta 24, el importador crea una línea por renglón del Excel, como lo cuentan hoy los B-26.';
COMMENT ON COLUMN fpa_budget_lines.car_rental IS
  'A2: viaje: renta de vehículo sí o no. Sin tarifa aún (pregunta 23): no suma. La renta que hoy se escribe a mano (16,000 por viaje en Comercial y Medición) va como una línea aparte de monto por mes, clasificación Renta de autos, como hace DG.';
COMMENT ON COLUMN fpa_budget_lines.contract_label IS
  'A2: contrato del área (Naes, Costos GE). Texto mientras se confirma la pregunta 32. NULL = sin dato.';
COMMENT ON COLUMN fpa_budget_lines.project_tag IS
  'A2: etiqueta de proyecto (CIL). Texto mientras se confirma la pregunta 26. NULL = sin dato.';
COMMENT ON COLUMN fpa_budget_lines.outside_ebitda IS
  'A2: true = no afecta EBITDA (cartas de crédito de Finanzas); false = sí lo afecta; NULL = sin dato. Por confirmar (pregunta 19).';
COMMENT ON COLUMN fpa_budget_lines.spend_type IS
  'A2: recurrente, extraordinario o inversión. NULL = sin clasificar. Por confirmar (pregunta 14).';
COMMENT ON COLUMN fpa_budget_lines.source_ref IS
  'A2: origen en el Excel importado (archivo corto y Hoja!Fila), p. ej. Compras B-26, Gastos sin viajes!4. NULL = capturada en pantalla.';

CREATE TABLE fpa_budget_line_months (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id    uuid NOT NULL REFERENCES fpa_budget_lines(id) ON DELETE CASCADE,
  month      smallint NOT NULL
    CONSTRAINT ck_fpa_budget_line_months_month CHECK (month BETWEEN 1 AND 12),
  quantity   numeric(12,4)
    CONSTRAINT ck_fpa_budget_line_months_quantity CHECK (quantity >= 0),
  unit_price numeric(15,4),
  amount     numeric(15,2),
  trips      smallint
    CONSTRAINT ck_fpa_budget_line_months_trips CHECK (trips >= 1),
  CONSTRAINT uq_fpa_budget_line_months UNIQUE (line_id, month),
  -- Un solo dato por mes: veces (precio × veces), monto (monto por mes) o
  -- viajes (viaje). Que coincida con la forma de la línea lo valida el service
  CONSTRAINT ck_fpa_budget_line_months_one_value
    CHECK (num_nonnulls(quantity, amount, trips) = 1),
  -- El precio del mes solo acompaña a las veces
  CONSTRAINT ck_fpa_budget_line_months_price
    CHECK (unit_price IS NULL OR quantity IS NOT NULL)
);

COMMENT ON TABLE fpa_budget_line_months IS
  'A2: lo capturado en cada mes de una línea; solo hay fila en los meses con dato. Se reescribe con su línea (por eso lleva DELETE y CASCADE). No guarda montos calculados: el mes en pesos = veces × precio × índice × tipo de cambio (o monto × índice × tipo de cambio, o viajes × costo del viaje), redondeado a centavos; el total de la línea es la suma de sus meses. Un dato que no es de la forma de la línea (veces en un viaje, un monto en precio × veces) o un mes hasta el corte de un forecast es un error: el service lo rechaza al guardar y fpa-calc lo marca, no lo omite.';
COMMENT ON COLUMN fpa_budget_line_months.unit_price IS
  'A2: precio del mes cuando cambia (Gympass: 69,000 ene–may y 79,000 jun–dic). NULL = el precio de la línea.';
COMMENT ON COLUMN fpa_budget_line_months.amount IS
  'A2: monto del mes en la moneda de la línea (monto por mes). Al repartir un total, el último mes absorbe los centavos; se guarda ya repartido.';

CREATE TABLE fpa_line_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id    uuid NOT NULL REFERENCES fpa_budget_lines(id),
  month      smallint
    CONSTRAINT ck_fpa_line_comments_month CHECK (month BETWEEN 1 AND 12),
  body       text NOT NULL
    CONSTRAINT ck_fpa_line_comments_body CHECK (btrim(body) <> ''),
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fpa_line_comments_line
  ON fpa_line_comments (line_id, created_at);

COMMENT ON TABLE fpa_line_comments IS
  'A2: comentarios de una línea, con autor y fecha ("Cuota anual Fijos durante 3 años"). month NULL = de toda la línea; 1–12 = de ese mes ("Fee de éxito" en octubre). No se editan: se ocultan con is_active.';

-- -----------------------------------------------------------------------------
-- Permisos. Sin DELETE: baja lógica con is_active o revocación. Los meses se
-- reescriben con su línea (DELETE explícito, como 0016). El historial y las
-- llaves son de solo inserción. En dev, los default privileges le dan arwd a
-- abent3t_app en toda tabla nueva: por eso se revoca DELETE de forma explícita
-- en todas las demás, para que dev se comporte como prod (sin verificar ahí).
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE         ON fpa_areas              TO abent3t_app;
GRANT SELECT, INSERT, UPDATE         ON fpa_departments        TO abent3t_app;
GRANT SELECT, INSERT, UPDATE         ON fpa_assignments        TO abent3t_app;
GRANT SELECT, INSERT, UPDATE         ON fpa_categories         TO abent3t_app;
GRANT SELECT, INSERT, UPDATE         ON fpa_classifications    TO abent3t_app;
GRANT SELECT, INSERT, UPDATE         ON fpa_versions           TO abent3t_app;
GRANT SELECT, INSERT, UPDATE         ON fpa_exchange_rates     TO abent3t_app;
GRANT SELECT, INSERT, UPDATE         ON fpa_travel_rates       TO abent3t_app;
GRANT SELECT, INSERT, UPDATE         ON fpa_budgets            TO abent3t_app;
GRANT SELECT, INSERT                 ON fpa_budget_events      TO abent3t_app;
GRANT SELECT, INSERT                 ON fpa_line_keys          TO abent3t_app;
GRANT SELECT, INSERT, UPDATE         ON fpa_budget_lines       TO abent3t_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON fpa_budget_line_months TO abent3t_app;
GRANT SELECT, INSERT, UPDATE         ON fpa_line_comments      TO abent3t_app;

REVOKE DELETE, TRUNCATE ON fpa_areas, fpa_departments, fpa_assignments,
  fpa_categories, fpa_classifications, fpa_versions, fpa_exchange_rates,
  fpa_travel_rates, fpa_budgets, fpa_budget_lines, fpa_line_comments
  FROM abent3t_app;
REVOKE UPDATE, DELETE, TRUNCATE ON fpa_budget_events FROM abent3t_app;
REVOKE UPDATE, DELETE, TRUNCATE ON fpa_line_keys     FROM abent3t_app;

COMMIT;
