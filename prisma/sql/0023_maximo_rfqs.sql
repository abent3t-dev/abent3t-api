-- =============================================================================
-- 0023_maximo_rfqs.sql — O2: solicitudes de cotización (RQ) de Maximo
--
-- Bloque O (documentation/TAREAS_COMPRAS_2026-10-20.md, O2). CIISA publicó la
-- Object Structure AB_COTIZACIONES (raíz RFQ; visto en prod el 17-nov): la
-- cabecera de la RQ con su historial completo de estatus (RFQSTATUS, colgado
-- de la cabecera) y sus líneas (RFQLINE, con el PONUM de la OC que salió de
-- cada una). Con eso la página de Maximo del avance semanal cuenta RQ, como
-- el reporte de Compras, en lugar de PR aprobadas.
--
--   * maximo_rfqs: staging de AB_COTIZACIONES, UNA fila por RQ. Clave natural
--     (rfqnum, siteid): la RQ de Maximo no tiene revisiones. `raw` = registro
--     crudo completo (se re-mapea sin re-descargar, como las demás tablas).
--     `superseded_at` = la RQ dejó de venir en dos corridas completas
--     seguidas (se borró en Maximo); las vistas la excluyen y se limpia si
--     reaparece.
--   * maximo_rfq_status_history: el historial RFQSTATUS de cada RQ (lo
--     reescriben staging y remap en la misma transacción que la RQ).
--   * maximo_sync_target: el target nuevo 'rfqs' del sync (flag propio,
--     MAXIMO_RFQS_ENABLED, apagado por defecto).
--
-- Aditiva y sin datos: las tablas nacen vacías y, con el flag apagado o sin
-- datos, la página de Maximo del avance sigue con las PR, como hoy.
--
-- Despliegue: en el servidor B ANTES del rebuild que incluya O2. El código
-- nuevo lee `maximo_rfqs` aunque el flag esté apagado (el comprador del
-- tablero de Compras, de Órdenes por comprador y del reporte semanal, y
-- GET /integrations/maximo/status; el avance, con el flag prendido): sin la
-- 0023 esas consultas fallan. Si una tabla está ocupada, espera hasta 5 s y
-- falla sin cambiar nada (lock_timeout): se vuelve a correr.
--
-- Rollback del código (volver al anterior a O2): las tablas y el valor del
-- enum se pueden quedar, PERO si ya corrió alguna sincronización de RQ, el
-- cliente de Prisma anterior no conoce el valor 'rfqs' y truena al leer
-- esas corridas (el historial de corridas de Integraciones). Antes de
-- regresar: DELETE FROM maximo_sync_runs WHERE target = 'rfqs';
-- (las RQ quedan con last_sync_run_id en NULL por el FK).
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- El valor nuevo no se usa dentro de esta transacción (PG ≥ 12 lo permite así)
ALTER TYPE maximo_sync_target ADD VALUE IF NOT EXISTS 'rfqs';

-- -----------------------------------------------------------------------------
-- Staging de AB_COTIZACIONES, una fila por RQ
-- -----------------------------------------------------------------------------
CREATE TABLE maximo_rfqs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfqnum           varchar(50) NOT NULL,
  siteid           varchar(20),
  description      text,
  status           varchar(30),
  status_date      timestamptz,
  enter_date       timestamptz,               -- ENTERDATE: creación de la RQ
  enter_by         varchar(100),              -- ENTERBY: "Introducido por" (el comprador)
  requested_by     varchar(100),              -- REQUESTEDBY: "Solicitado por" (usuario del área)
  required_date    timestamptz,               -- REQUIREDDATE
  closed_at        timestamptz,               -- último CLOSE del historial
  closed_by        varchar(100),
  cancelled_at     timestamptz,               -- último CANCEL del historial
  cancelled_by     varchar(100),
  po_nums          text[] NOT NULL DEFAULT '{}',
  raw_hash         varchar(64),
  rowstamp         varchar(100),
  raw              jsonb NOT NULL,
  mapper_version   text  NOT NULL,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_changed_at  timestamptz,
  last_sync_run_id uuid REFERENCES maximo_sync_runs(id) ON DELETE SET NULL,
  superseded_at    timestamptz
);

CREATE UNIQUE INDEX uq_maximo_rfq_natural_key
  ON maximo_rfqs (rfqnum, coalesce(siteid, ''));
CREATE INDEX idx_maximo_rfq_status     ON maximo_rfqs (status);
CREATE INDEX idx_maximo_rfq_enter_date ON maximo_rfqs (enter_date);
-- Sin índice en last_seen_at: cada corrida (cada hora) lo toca en TODAS las
-- RQ; sin índice ese UPDATE puede ser HOT y no crece el GIN. El GIN sin
-- fastupdate: sin lista pendiente que el comprador por PONUM recorra entera.
CREATE INDEX idx_maximo_rfq_po_nums    ON maximo_rfqs USING gin (po_nums)
  WITH (fastupdate = off);

COMMENT ON TABLE maximo_rfqs IS
  'Staging de AB_COTIZACIONES (solicitudes de cotización de Maximo), una fila por RQ. raw = registro crudo original (RFQSTATUS y RFQLINE completos).';
COMMENT ON COLUMN maximo_rfqs.enter_date IS
  'ENTERDATE: creación de la RQ. Es la "recibida" de la página de Maximo del avance semanal (O2).';
COMMENT ON COLUMN maximo_rfqs.enter_by IS
  'ENTERBY ("Introducido por"): el comprador. Gana sobre el comprador de RFQSTATUS de AB_COMPRAS si no coinciden (O3).';
COMMENT ON COLUMN maximo_rfqs.requested_by IS 'REQUESTEDBY ("Solicitado por"): el usuario del área.';
COMMENT ON COLUMN maximo_rfqs.closed_at IS
  'CHANGEDATE del último CLOSE de su historial (RFQSTATUS). NULL = sin CLOSE en el historial.';
COMMENT ON COLUMN maximo_rfqs.cancelled_at IS
  'CHANGEDATE del último CANCEL de su historial. NULL = sin CANCEL en el historial.';
COMMENT ON COLUMN maximo_rfqs.po_nums IS
  'PONUM de sus líneas (RFQLINE), distintos y ordenados: la liga con las OC que salieron de la RQ.';
COMMENT ON COLUMN maximo_rfqs.superseded_at IS
  'La RQ dejó de venir en dos corridas completas seguidas (se borró en Maximo). Las vistas la excluyen; se limpia si reaparece.';

-- -----------------------------------------------------------------------------
-- Historial RFQSTATUS de cada RQ
-- -----------------------------------------------------------------------------
CREATE TABLE maximo_rfq_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id      uuid NOT NULL REFERENCES maximo_rfqs(id) ON DELETE CASCADE,
  rfqnum      varchar(50) NOT NULL,
  siteid      varchar(20),
  seq         int NOT NULL,             -- orden del cambio (CHANGEDATE, desempate RFQSTATUSSEQ)
  status      varchar(30) NOT NULL,
  change_date timestamptz,
  changed_by  varchar(100),             -- usuario de Maximo (CHANGEBY)
  memo        text,                     -- MEMO (p. ej. el motivo de la cancelación)
  CONSTRAINT uq_maximo_rfq_status_history UNIQUE (rfq_id, seq)
);

CREATE INDEX idx_maximo_rfq_hist_rfqnum      ON maximo_rfq_status_history (rfqnum);
CREATE INDEX idx_maximo_rfq_hist_status_date ON maximo_rfq_status_history (status, change_date);

COMMENT ON TABLE maximo_rfq_status_history IS
  'RFQSTATUS de cada RQ de Maximo (derivado del raw; lo reescriben staging y remap). INPRG = en progreso; SENT = enviada a proveedores; WREV = en revisión; CLOSE = cerrada; CANCEL = cancelada.';

GRANT SELECT, INSERT, UPDATE, DELETE ON maximo_rfqs               TO abent3t_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON maximo_rfq_status_history TO abent3t_app;

COMMIT;
