-- =============================================================================
-- 0027_almacen_version2.sql — Almacén: la versión 2 del reporte de inventario al corte
--
-- Lo que pidió Mariana el 2026-11-25 (documentation/ALMACEN.md, "Versión 2 en el módulo"; INVENTARIO_HENRY.md, "Versión 2"):
--   * todos los almacenes y ubicaciones, no solo CENTRAL: el corte publicado pasa a ser uno por fecha de corte (antes, por almacén y
--     fecha) y guarda la lista de ubicaciones (clave, descripción de Maximo, tipo y grupo) para el filtro de la página;
--   * lo que va sin costo, aparte: cada fila sin costo guarda su motivo y cómo llegó el saldo a ese almacén;
--   * las devoluciones al almacén sin orden de trabajo (1-oct-2026 al corte): tabla nueva, de solo inserción, y su serie por mes en
--     el corte;
--   * la versión del reporte (la del Excel, p. ej. 2) y su estado de revisión con Contabilidad ('en_revision' o 'aceptado'): la
--     carga entra en revisión; `npm run almacen:cargar -- --aceptar` lo marca aceptado sin volver a cargar.
-- Aditiva: columnas con valor por omisión y una tabla nueva. Los dos índices únicos se rehacen por fecha (prod tiene 0 cortes; en
-- dev, uno). Nada se borra.
--
-- Despliegue: en el servidor B ANTES del rebuild que incluya este código (el api nuevo ya pide estas columnas).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- Cortes
-- -----------------------------------------------------------------------------
ALTER TABLE almacen_cortes
  ADD COLUMN version_reporte      smallint    NOT NULL DEFAULT 1,
  ADD COLUMN revision             varchar(12) NOT NULL DEFAULT 'en_revision',
  ADD COLUMN aceptado_en          timestamptz,
  ADD COLUMN ubicaciones          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN devoluciones_por_mes jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT ck_almacen_cortes_version_reporte CHECK (version_reporte >= 1),
  ADD CONSTRAINT ck_almacen_cortes_revision CHECK (revision IN ('en_revision', 'aceptado')),
  ADD CONSTRAINT ck_almacen_cortes_aceptado CHECK ((revision = 'aceptado') = (aceptado_en IS NOT NULL)),
  ADD CONSTRAINT ck_almacen_cortes_ubicaciones CHECK (jsonb_typeof(ubicaciones) = 'array'),
  ADD CONSTRAINT ck_almacen_cortes_devoluciones_por_mes CHECK (jsonb_typeof(devoluciones_por_mes) = 'array');

-- Un solo reporte publicado por fecha de corte, y la versión de carga se cuenta por fecha: la versión 2 cubre todas las ubicaciones
-- y reemplaza a la de CENTRAL de la misma fecha.
DROP INDEX uq_almacen_cortes_publicado;
CREATE UNIQUE INDEX uq_almacen_cortes_publicado ON almacen_cortes (fecha_corte) WHERE estado = 'publicado';
ALTER TABLE almacen_cortes DROP CONSTRAINT uq_almacen_cortes_version;
ALTER TABLE almacen_cortes ADD CONSTRAINT uq_almacen_cortes_version UNIQUE (fecha_corte, version);

COMMENT ON COLUMN almacen_cortes.almacen IS
  'El alcance del corte: CENTRAL en la versión 1, TODOS desde la versión 2 (cada fila de existencias dice su almacén).';
COMMENT ON COLUMN almacen_cortes.version_reporte IS
  'La versión del reporte que se entregó (la del Excel). La columna version cuenta las cargas de la misma fecha de corte.';
COMMENT ON COLUMN almacen_cortes.revision IS
  'en_revision mientras Contabilidad lo revisa; aceptado cuando lo acepta (npm run almacen:cargar -- --aceptar).';
COMMENT ON COLUMN almacen_cortes.ubicaciones IS
  '[{clave, descripcion, tipo, grupo}]: las ubicaciones del corte, con su descripción y tipo de Maximo y el grupo del reporte.';
COMMENT ON COLUMN almacen_cortes.devoluciones_por_mes IS
  '[{mes: AAAA-MM, lineas, unidades}]: las devoluciones al almacén sin orden de trabajo por mes desde 2019 (hoja Resumen del Excel).';

-- -----------------------------------------------------------------------------
-- Existencias: lo que va sin costo dice por qué y cómo llegó; "en su inventario" solo aplica en CENTRAL
-- -----------------------------------------------------------------------------
ALTER TABLE almacen_existencias
  ADD COLUMN motivo     varchar(60),
  ADD COLUMN como_llego text,
  ALTER COLUMN en_su_inventario DROP NOT NULL,
  ADD CONSTRAINT ck_almacen_existencias_motivo CHECK (motivo IS NULL OR (origen = 'Sin entrada con costo' AND btrim(motivo) <> ''));

COMMENT ON COLUMN almacen_existencias.motivo IS
  'Solo en lo que va sin costo: Sin compras en Maximo, Solo compras de salida directa, Sus compras no alcanzan o Devolución en 0 (puede ir más de uno, con " y ").';
COMMENT ON COLUMN almacen_existencias.en_su_inventario IS
  'Si está en su INVENTARIO AL CORTE, que solo trae CENTRAL: fuera de CENTRAL va vacío (no aplica).';

-- -----------------------------------------------------------------------------
-- Devoluciones al almacén sin orden de trabajo (del 1-oct-2026 al corte)
-- -----------------------------------------------------------------------------
CREATE TABLE almacen_devoluciones (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corte_id              uuid          NOT NULL REFERENCES almacen_cortes(id),
  -- El renglón en la hoja "Devoluciones sin OT" del Excel
  orden                 integer       NOT NULL,
  -- Hora de México, sin zona, como en almacen_existencias
  fecha                 timestamp(0)  NOT NULL,
  fecha_captura         timestamp(0),
  -- El documento de uso de Maximo (INVUSE) con el que se capturó, y su descripción
  documento             varchar(20),
  documento_descripcion text,
  almacen               varchar(30)   NOT NULL,
  anaquel               varchar(30),
  parte                 varchar(30)   NOT NULL,
  descripcion           text          NOT NULL,
  cantidad              numeric(18,4) NOT NULL,
  unidad                varchar(20),
  -- Lo que les puso Maximo, en dólares (0 en muchas)
  costo_maximo_usd      numeric(20,6) NOT NULL,
  -- A costo de compra, como en las existencias; sin costo si el artículo no tiene recepciones y Maximo la tiene en 0
  costo                 numeric(20,6),
  moneda                varchar(3),
  tipo_cambio           numeric(14,6),
  importe_pesos         numeric(20,6),
  tipo_cambio_oc        numeric(14,6),
  importe_pesos_oc      numeric(20,6),
  valuacion             varchar(80),
  oc                    varchar(40),
  observacion           text,
  marcas                text[]        NOT NULL DEFAULT '{}',
  -- Del artículo (se repite en cada una de sus líneas): lo que había salido del almacén antes, la última salida y los saldos al corte
  salio_antes           numeric(18,4),
  salio_12m             numeric(18,4),
  ultima_salida         timestamp(0),
  ot_ultima_salida      varchar(30),
  saldo_almacen         numeric(18,4),
  saldo_otras           numeric(18,4),
  CONSTRAINT uq_almacen_devoluciones_orden UNIQUE (corte_id, orden),
  CONSTRAINT ck_almacen_devoluciones_orden    CHECK (orden >= 1),
  CONSTRAINT ck_almacen_devoluciones_cantidad CHECK (cantidad > 0),
  CONSTRAINT ck_almacen_devoluciones_parte    CHECK (btrim(parte) <> '' AND btrim(almacen) <> ''),
  CONSTRAINT ck_almacen_devoluciones_costo_maximo CHECK (costo_maximo_usd >= 0),
  CONSTRAINT ck_almacen_devoluciones_moneda   CHECK (moneda IS NULL OR moneda ~ '^[A-Z]{3}$'),
  -- Valuada: costo, moneda, los dos tipos de cambio y los dos importes, todos positivos; sin costo: ninguno.
  CONSTRAINT ck_almacen_devoluciones_valuada CHECK (
    (costo IS NULL AND moneda IS NULL AND tipo_cambio IS NULL AND importe_pesos IS NULL
       AND tipo_cambio_oc IS NULL AND importe_pesos_oc IS NULL)
    OR (costo IS NOT NULL AND costo > 0 AND moneda IS NOT NULL
       AND tipo_cambio IS NOT NULL AND tipo_cambio > 0 AND importe_pesos IS NOT NULL AND importe_pesos > 0
       AND tipo_cambio_oc IS NOT NULL AND tipo_cambio_oc > 0 AND importe_pesos_oc IS NOT NULL AND importe_pesos_oc > 0)),
  CONSTRAINT ck_almacen_devoluciones_mxn CHECK (moneda IS DISTINCT FROM 'MXN' OR (tipo_cambio = 1 AND tipo_cambio_oc = 1))
);

CREATE INDEX ix_almacen_devoluciones_corte_parte ON almacen_devoluciones (corte_id, parte);

COMMENT ON TABLE almacen_devoluciones IS
  'Almacén (0027): las devoluciones al almacén sin orden de trabajo ni salida ligada del 1-oct-2026 al corte, una por línea de la hoja "Devoluciones sin OT" del Excel del corte, con el análisis por artículo. Solo inserción: se carga junto con su corte.';

-- -----------------------------------------------------------------------------
-- Permisos. La app marca aceptado un corte (revision, aceptado_en), además de reemplazarlo (estado, reemplazado_en).
-- Las devoluciones son de solo inserción. En dev, los default privileges dan arwd en toda tabla nueva: se revoca explícito.
-- -----------------------------------------------------------------------------
GRANT UPDATE (revision, aceptado_en) ON almacen_cortes TO abent3t_app;
REVOKE UPDATE, DELETE, TRUNCATE ON almacen_devoluciones FROM abent3t_app;
GRANT SELECT, INSERT ON almacen_devoluciones TO abent3t_app;

COMMIT;
