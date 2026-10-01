-- =============================================================================
-- 0018_correo_seguro.sql — Correo seguro antes de habilitar el envío (J1, J2)
--
-- Hilo con César del 2026-10-01: controles de seguridad y mínimo privilegio
-- antes de habilitar el envío de correo. Una sola migración para el bloque.
--
--   * J2  contracts.vencido_historico: los contratos que ya estaban vencidos
--         cuando se cargó la base real (1-oct-2026) son "vencido (histórico)"
--         y NO generan avisos. Compras lo desmarca a mano si alguno sí está en
--         renovación. Los avisos simulados que ya se habían registrado de esos
--         contratos se borran (nunca salieron: el correo está en simulación).
--   * J1  email_outbox: cola y bitácora de TODOS los correos (contratos,
--         expeditación, comité y recordatorios de capacitación). Llave de
--         idempotencia = plantilla + entidad + destinatario + día, UNIQUE.
--         Estados: pendiente, enviando, enviado, simulado, error, rechazado
--         (destinatario fuera del dominio permitido).
--         email_settings: el interruptor "Pausar envíos" (una sola fila); el
--         tope diario se calcula, no se guarda.
-- =============================================================================

BEGIN;

-- ── J2: vencidos históricos ─────────────────────────────────────────────────
ALTER TABLE contracts
  ADD COLUMN vencido_historico boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN contracts.vencido_historico IS
  'J2: vencido antes de la carga de la base real (1-oct-2026) o dado de alta ya vencido: sin avisos de vencimiento. Compras lo desmarca si está en renovación';

-- Solo la base real (activos). Los vencidos sin fecha de fin (así venían en
-- el Excel) también son históricos.
UPDATE contracts
   SET vencido_historico = true
 WHERE is_active
   AND ((end_date IS NOT NULL AND end_date < DATE '2026-10-01'
         AND status IN ('vigente', 'vencido'))
     OR (end_date IS NULL AND status = 'vencido'));

DELETE FROM contract_expiry_notifications n
 USING contracts c
 WHERE n.contract_id = c.id
   AND c.vencido_historico;

-- ── J1: cola y bitácora de correo ───────────────────────────────────────────
CREATE TABLE email_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key     varchar(400) NOT NULL,
  template            varchar(60)  NOT NULL,
  entity_type         varchar(40),
  entity_id           varchar(120),
  recipient_email     varchar(255) NOT NULL,
  recipient_name      varchar(255),
  subject             varchar(500) NOT NULL,
  body                text         NOT NULL,
  is_html             boolean      NOT NULL DEFAULT true,
  status              varchar(20)  NOT NULL DEFAULT 'pendiente'
    CONSTRAINT ck_email_outbox_status CHECK (status IN
      ('pendiente', 'enviando', 'enviado', 'simulado', 'error', 'rechazado')),
  attempts            integer      NOT NULL DEFAULT 0,
  last_error          text,
  transport           varchar(20),
  provider_message_id varchar(255),
  created_at          timestamptz  NOT NULL DEFAULT now(),
  scheduled_at        timestamptz  NOT NULL DEFAULT now(),
  last_attempt_at     timestamptz,
  sent_at             timestamptz,
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uq_email_outbox_key UNIQUE (idempotency_key)
);

CREATE INDEX idx_email_outbox_due ON email_outbox (status, scheduled_at);
CREATE INDEX idx_email_outbox_created ON email_outbox (created_at DESC);
CREATE INDEX idx_email_outbox_sent ON email_outbox (sent_at);
CREATE INDEX idx_email_outbox_attempt ON email_outbox (last_attempt_at);

COMMENT ON TABLE email_outbox IS
  'J1: cola y bitácora de correo; el único que envía es el worker (ritmo EMAIL_MIN_INTERVAL_SECONDS, tope EMAIL_DAILY_CAP)';
COMMENT ON COLUMN email_outbox.idempotency_key IS
  'plantilla:entidad:id:destinatario:día (CDMX): el mismo aviso dos veces el mismo día es un solo registro';

CREATE TABLE email_settings (
  id            smallint PRIMARY KEY DEFAULT 1 CONSTRAINT ck_email_settings_singleton CHECK (id = 1),
  paused        boolean NOT NULL DEFAULT false,
  paused_reason varchar(500),
  paused_at     timestamptz,
  paused_by     uuid,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO email_settings (id) VALUES (1);

COMMENT ON TABLE email_settings IS
  'J1: interruptor "Pausar envíos" (super_admin), sin deploy';

-- La bitácora no se borra desde la app
GRANT SELECT, INSERT, UPDATE ON email_outbox TO abent3t_app;
GRANT SELECT, UPDATE ON email_settings TO abent3t_app;

COMMIT;
