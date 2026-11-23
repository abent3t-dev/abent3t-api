-- =============================================================================
-- 0026_almacen_cortes.sql — Almacén: el reporte de inventario al corte
--
-- Módulo nuevo (junta del 2026-11-19; documentation/ALMACEN.md). La primera
-- versión no lee Maximo: guarda el reporte ya calculado y aceptado por
-- Contabilidad (documentation/INVENTARIO_HENRY.md), que se carga con
-- `npm run almacen:cargar` en un contenedor efímero. Aditiva; no siembra datos.
--
--   * user_module += 'almacen'; user_role += 'almacen_consulta' (solo lectura;
--     lo asigna super_admin). Un valor de enum NO se puede borrar: Alex aprobó
--     estos nombres el 2026-11-23. Nada de esta migración los usa, así que van
--     en la misma transacción (como 0021).
--   * almacen_cortes: un corte cargado, con sus totales, sus notas y el Excel
--     aceptado tal cual (bytea, unos 2 MB) para descargarlo.
--   * almacen_existencias: lo que queda de cada entrada al corte (una fila por
--     fila de la hoja "Existencias al corte").
--   * Las fechas son de Maximo, en hora de México: van sin zona (timestamp) y
--     la pantalla las muestra tal cual. Con zona, las de verano de 2019 a 2022
--     (horario de verano) se correrían una hora.
--   * Nada se borra: si Contabilidad pide cambios, se carga otro paquete
--     (versión siguiente de la misma fecha) y el anterior queda 'reemplazado';
--     cargar otra vez el paquete de una versión reemplazada la vuelve a
--     publicar. Un solo corte publicado por almacén y fecha (índice parcial).
--   * La llave de una carga es la huella del paquete completo (filas, notas,
--     totales y Excel), no la del Excel: con el mismo Excel puede cambiar la
--     clasificación, que sale de otro archivo.
--   * Estados como varchar + CHECK ck_ (patrón 0018), no enums.
--   * Permisos: sin DELETE, y de un corte solo cambian su estado y la fecha en
--     que se reemplazó (UPDATE por columna). En dev, los default privileges dan
--     UPDATE y DELETE en toda tabla nueva: aquí se revocan explícito, para que
--     dev se comporte como prod.
--
-- Despliegue: el código del módulo se sube a main, así que en prod esta
-- migración va en el servidor B ANTES del primer rebuild que lo incluya. El
-- rol se asigna cuando se lance; el corte se carga cuando lo acepten.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Módulo y rol (aprobados por Alex el 2026-11-23; no se pueden quitar)
-- -----------------------------------------------------------------------------
ALTER TYPE user_module ADD VALUE IF NOT EXISTS 'almacen';
ALTER TYPE user_role   ADD VALUE IF NOT EXISTS 'almacen_consulta';

-- -----------------------------------------------------------------------------
-- Cortes del reporte
-- -----------------------------------------------------------------------------
CREATE TABLE almacen_cortes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  almacen              varchar(30)   NOT NULL,
  -- Hora de México, como la da Maximo (sin zona; ver el encabezado)
  fecha_corte          timestamp(0)  NOT NULL,
  version              smallint      NOT NULL,
  estado               varchar(12)   NOT NULL DEFAULT 'publicado',
  titulo               varchar(160)  NOT NULL,
  -- De dónde salen los datos: qué lectura de Maximo y cuándo
  fuente               text          NOT NULL,
  articulos            integer       NOT NULL,
  unidades             numeric(18,4) NOT NULL,
  -- Con el tipo de cambio del día de cada entrada y con el de la OC
  total_pesos          numeric(20,6) NOT NULL,
  total_pesos_oc       numeric(20,6) NOT NULL,
  sin_valuar_articulos integer       NOT NULL,
  sin_valuar_unidades  numeric(18,4) NOT NULL,
  -- La hoja "Notas": [["título", "texto"], ...]
  notas                jsonb         NOT NULL,
  archivo_nombre       varchar(160)  NOT NULL,
  archivo              bytea         NOT NULL,
  -- El del Excel; se puede repetir (mismo Excel, otra clasificación)
  archivo_sha256       char(64)      NOT NULL,
  -- La huella del paquete completo: la llave de la carga
  paquete_sha256       char(64)      NOT NULL,
  cargado_por          varchar(120)  NOT NULL,
  cargado_en           timestamptz   NOT NULL DEFAULT now(),
  reemplazado_en       timestamptz,
  CONSTRAINT uq_almacen_cortes_paquete UNIQUE (paquete_sha256),
  CONSTRAINT uq_almacen_cortes_version UNIQUE (almacen, fecha_corte, version),
  CONSTRAINT ck_almacen_cortes_estado  CHECK (estado IN ('publicado', 'reemplazado')),
  CONSTRAINT ck_almacen_cortes_reemplazo
    CHECK ((estado = 'reemplazado') = (reemplazado_en IS NOT NULL)),
  CONSTRAINT ck_almacen_cortes_version CHECK (version >= 1),
  CONSTRAINT ck_almacen_cortes_almacen
    CHECK (btrim(almacen) <> '' AND almacen = btrim(almacen)),
  CONSTRAINT ck_almacen_cortes_titulo  CHECK (btrim(titulo) <> ''),
  CONSTRAINT ck_almacen_cortes_sha256
    CHECK (archivo_sha256 ~ '^[0-9a-f]{64}$' AND paquete_sha256 ~ '^[0-9a-f]{64}$'),
  -- El nombre va tal cual en la cabecera de la descarga (Content-Disposition):
  -- ASCII imprimible, sin comillas ni diagonal invertida
  CONSTRAINT ck_almacen_cortes_archivo
    CHECK (octet_length(archivo) > 0 AND archivo_nombre ~ '^[ -~]+[.]xlsx$'
           AND archivo_nombre !~ '["\\]'),
  CONSTRAINT ck_almacen_cortes_cifras
    CHECK (articulos >= 0 AND unidades >= 0 AND total_pesos >= 0 AND total_pesos_oc >= 0
           AND sin_valuar_articulos >= 0 AND sin_valuar_unidades >= 0
           AND sin_valuar_articulos <= articulos),
  CONSTRAINT ck_almacen_cortes_notas   CHECK (jsonb_typeof(notas) = 'array')
);

-- Un solo corte publicado por almacén y fecha de corte
CREATE UNIQUE INDEX uq_almacen_cortes_publicado
  ON almacen_cortes (almacen, fecha_corte) WHERE estado = 'publicado';

COMMENT ON TABLE almacen_cortes IS
  'Almacén (0026): un corte del reporte de inventario, ya calculado y aceptado por Contabilidad (documentation/INVENTARIO_HENRY.md), con sus totales, sus notas y el Excel tal cual. Lo carga npm run almacen:cargar. Si piden cambios se carga la versión siguiente de la misma fecha y esta queda reemplazada (cargar otra vez su paquete la vuelve a publicar); nada se borra.';
COMMENT ON COLUMN almacen_cortes.paquete_sha256 IS
  'Huella del paquete completo (filas, notas, totales y Excel; almacen-carga.ts): la llave de la carga. El archivo_sha256 del Excel se puede repetir.';
COMMENT ON COLUMN almacen_cortes.fecha_corte IS
  'Hora de México, como Maximo, sin zona: la pantalla la muestra tal cual.';
COMMENT ON COLUMN almacen_cortes.total_pesos IS
  'Con el tipo de cambio del día de cada entrada (tabla EXCHANGE de Maximo).';
COMMENT ON COLUMN almacen_cortes.total_pesos_oc IS
  'Con el tipo de cambio de la orden de compra (EXCHANGERATE2 de la entrada, o el de su OC).';

-- -----------------------------------------------------------------------------
-- Lo que queda de cada entrada al corte
-- -----------------------------------------------------------------------------
CREATE TABLE almacen_existencias (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corte_id             uuid          NOT NULL REFERENCES almacen_cortes(id),
  -- El renglón en la hoja del Excel (para conservar su orden)
  orden                integer       NOT NULL,
  parte                varchar(30)   NOT NULL,
  descripcion          text          NOT NULL,
  almacen              varchar(30)   NOT NULL,
  almacen_fisico       varchar(60),
  -- La de su reporte de inventario (p. ej. 'PARTES \ MEC \ BOYA');
  -- HERRAMIENTAS para las herramientas, que ese reporte no trae
  clasificacion        varchar(200),
  -- Sin costo = "Sin entrada con costo"
  costo                numeric(20,6),
  moneda               varchar(3),
  cantidad             numeric(18,4) NOT NULL,
  unidad               varchar(20),
  -- Hora de México, sin zona (ver el encabezado)
  fecha_entrada        timestamp(0),
  fecha_captura        timestamp(0),
  tipo_cambio          numeric(14,6),
  importe_pesos        numeric(20,6),
  tipo_cambio_oc       numeric(14,6),
  importe_pesos_oc     numeric(20,6),
  origen               varchar(40)   NOT NULL,
  oc                   varchar(40),
  fuente_tc            varchar(160),
  fuente_tc_oc         varchar(160),
  saldo_articulo       numeric(18,4) NOT NULL,
  -- Unidades del artículo que regresaron al almacén en las semanas previas al
  -- corte (en el del 9-nov-2026: desde el 1-oct, 180 devoluciones sin OT)
  regresaron_recientes numeric(18,4),
  herramienta          boolean       NOT NULL,
  en_su_inventario     boolean       NOT NULL,
  unidad_entrada       varchar(20),
  nota                 text,
  CONSTRAINT uq_almacen_existencias_orden UNIQUE (corte_id, orden),
  CONSTRAINT ck_almacen_existencias_cantidad CHECK (cantidad > 0 AND saldo_articulo > 0),
  CONSTRAINT ck_almacen_existencias_orden    CHECK (orden >= 1),
  CONSTRAINT ck_almacen_existencias_parte    CHECK (btrim(parte) <> ''),
  CONSTRAINT ck_almacen_existencias_moneda   CHECK (moneda IS NULL OR moneda ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_almacen_existencias_origen   CHECK (origen IN (
    'Recepción', 'Devolución al almacén', 'Recepción de salida directa',
    'Recepción a otro almacén', 'Sin entrada con costo')),
  -- Una fila valuada trae costo, moneda, fecha, los dos tipos de cambio y los
  -- dos importes, todos positivos; una "Sin entrada con costo" no trae ninguno.
  -- Los IS NOT NULL van explícitos: un CHECK que da NULL (NULL > 0) se acepta.
  CONSTRAINT ck_almacen_existencias_valuada CHECK (
    (origen = 'Sin entrada con costo'
       AND costo IS NULL AND moneda IS NULL AND fecha_entrada IS NULL
       AND tipo_cambio IS NULL AND importe_pesos IS NULL
       AND tipo_cambio_oc IS NULL AND importe_pesos_oc IS NULL)
    OR (origen <> 'Sin entrada con costo'
       AND costo IS NOT NULL AND costo > 0 AND moneda IS NOT NULL
       AND fecha_entrada IS NOT NULL
       AND tipo_cambio IS NOT NULL AND tipo_cambio > 0
       AND importe_pesos IS NOT NULL AND importe_pesos > 0
       AND tipo_cambio_oc IS NOT NULL AND tipo_cambio_oc > 0
       AND importe_pesos_oc IS NOT NULL AND importe_pesos_oc > 0)),
  -- En pesos, los dos tipos de cambio son 1
  CONSTRAINT ck_almacen_existencias_mxn CHECK (
    moneda IS DISTINCT FROM 'MXN' OR (tipo_cambio = 1 AND tipo_cambio_oc = 1))
);

CREATE INDEX ix_almacen_existencias_corte_parte ON almacen_existencias (corte_id, parte);

COMMENT ON TABLE almacen_existencias IS
  'Almacén (0026): lo que queda de cada entrada en el almacén al corte, una fila por fila de la hoja "Existencias al corte" del Excel del corte. Los importes son costo × cantidad × tipo de cambio, sin redondear. Solo inserción: se carga junto con su corte.';

-- -----------------------------------------------------------------------------
-- Permisos. Sin DELETE: un corte se reemplaza con otro, y de él solo cambian
-- estado y reemplazado_en. Las existencias son de solo inserción. En dev, los
-- default privileges le dan arwd a abent3t_app en toda tabla nueva: por eso se
-- revoca primero (quitar el UPDATE de la tabla quita también el de sus
-- columnas) y después se da el UPDATE por columna.
-- -----------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON almacen_cortes      FROM abent3t_app;
REVOKE UPDATE, DELETE, TRUNCATE ON almacen_existencias FROM abent3t_app;

GRANT SELECT, INSERT ON almacen_cortes      TO abent3t_app;
GRANT UPDATE (estado, reemplazado_en) ON almacen_cortes TO abent3t_app;
GRANT SELECT, INSERT ON almacen_existencias TO abent3t_app;

COMMIT;
