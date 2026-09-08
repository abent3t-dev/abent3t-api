-- ============================================================================
-- 0008_expediting.sql — Fase Expeditación: seguimiento de entregas de POs
-- ============================================================================
-- Aplica SOLO a purchase_orders propias (las POs del staging de integraciones
-- son de solo lectura y no se expeditan desde ABENT — regla 1 de la fase).
--
-- `current_status` persiste únicamente lo CAPTURADO (pendiente/en_transito/
-- entregada_parcial/entregada, escritor único: ExpeditingService); el estatus
-- operativo (en_tiempo/en_riesgo/retrasada) se DERIVA de fechas en el service
-- (regla 3). Idempotencia de alertas por UNIQUE (tracking, tipo, fecha):
-- preventiva/recordatorio usan la fecha esperada como fecha-clave (una vez
-- por vencimiento; una reprogramación rearma la alerta), la crítica usa el
-- día (diaria, §Alertas del doc: -15 / vencida / +7).
-- ============================================================================

CREATE TYPE delivery_status AS ENUM
  ('pendiente', 'en_transito', 'entregada_parcial', 'entregada');
CREATE TYPE delivery_event_type AS ENUM
  ('seguimiento', 'reprogramacion', 'recepcion_parcial', 'recepcion_total');

-- ----------------------------------------------------------------------------
-- Seguimiento (1 por orden de compra; creación perezosa al primer evento)
-- ----------------------------------------------------------------------------
CREATE TABLE delivery_tracking (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id     uuid NOT NULL UNIQUE REFERENCES purchase_orders(id),
  expected_date         date NOT NULL,          -- fecha vigente (reprogramable);
                                                -- la ORIGINAL de la PO es la que
                                                -- mide on_time_delivery_rate
  current_status        delivery_status NOT NULL DEFAULT 'pendiente',
  last_alert_sent       timestamptz,
  alert_count           int NOT NULL DEFAULT 0,
  delivery_confirmed_at timestamptz,
  confirmed_by          uuid REFERENCES profiles(id),
  notes                 text,
  is_active             boolean NOT NULL DEFAULT true
);

CREATE INDEX idx_delivery_tracking_expected ON delivery_tracking (expected_date);
CREATE INDEX idx_delivery_tracking_status   ON delivery_tracking (current_status);

-- ----------------------------------------------------------------------------
-- Historial: notas de contacto, reprogramaciones y recepciones
-- ----------------------------------------------------------------------------
CREATE TABLE delivery_tracking_events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_tracking_id   uuid NOT NULL REFERENCES delivery_tracking(id),
  event_type             delivery_event_type NOT NULL,
  comment                text,
  previous_expected_date date,                  -- reprogramación
  new_expected_date      date,                  -- reprogramación
  received_date          date,                  -- recepciones
  quantity               numeric(12,2),         -- recepción parcial (libre: la PO no modela partidas)
  created_by             uuid REFERENCES profiles(id),
  created_at             timestamptz DEFAULT now()
);

CREATE INDEX idx_delivery_events_tracking
  ON delivery_tracking_events (delivery_tracking_id);

-- ----------------------------------------------------------------------------
-- Alertas enviadas (idempotencia del job diario)
-- ----------------------------------------------------------------------------
CREATE TABLE expediting_alerts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_tracking_id uuid NOT NULL REFERENCES delivery_tracking(id),
  alert_type           text NOT NULL,           -- 'preventiva' | 'recordatorio' | 'critica'
  alert_date           date NOT NULL,           -- clave de idempotencia (ver cabecera)
  sent_to              text[] NOT NULL,
  sent_at              timestamptz DEFAULT now(),
  is_active            boolean NOT NULL DEFAULT true,
  CONSTRAINT uq_expediting_alert UNIQUE (delivery_tracking_id, alert_type, alert_date)
);

CREATE INDEX idx_expediting_alerts_tracking
  ON expediting_alerts (delivery_tracking_id);

-- ----------------------------------------------------------------------------
-- Permisos del rol de la aplicación (sin DELETE)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON delivery_tracking        TO abent3t_app;
GRANT SELECT, INSERT, UPDATE ON delivery_tracking_events TO abent3t_app;
GRANT SELECT, INSERT, UPDATE ON expediting_alerts        TO abent3t_app;
