-- =============================================================================
-- 0004_auth_events.sql
-- Tabla de bitácora de autenticación (PDF v3.0 §8.3; MIGRATION.md §3.4).
--
-- Registra TODOS los intentos de autenticación (éxito y fallo) para:
--   * Detección de abuso (rate limit en NestJS + posibles ataques).
--   * Compliance (Sentinel / Azure Monitor lo ingiere desde aquí).
--   * Auditoría operativa (admin_rh / super_admin pueden consultarlo).
--
-- Eventos:
--   * 'login_success'         — autenticación exitosa
--   * 'login_failed_password' — password incorrecto
--   * 'login_failed_user'     — usuario no existe en local_credentials
--   * 'login_failed_inactive' — perfil desactivado
--   * 'login_failed_locked'   — locked_until > now()
--   * 'login_failed_domain'   — dominio NO @abent3t.com (solo OIDC)
--   * 'logout'                — cierre de sesión
--   * 'refresh'                — rotación de access token
--   * 'password_set'          — admin estableció password local
--   * 'password_changed'      — usuario cambió su propio password
--
-- Adicional a `audit_logs` (que es bitácora de negocio). Ambos coexisten.
-- =============================================================================

BEGIN;

CREATE TABLE auth_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    varchar(50) NOT NULL,
  email         varchar(255),
  profile_id    uuid,
  success       boolean NOT NULL,
  reason        varchar(255),
  ip_address    varchar(45),
  user_agent    text,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_events_profile_id_fkey
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL
);

CREATE INDEX idx_auth_events_created_at ON auth_events (created_at DESC);
CREATE INDEX idx_auth_events_email      ON auth_events (email);
CREATE INDEX idx_auth_events_profile    ON auth_events (profile_id);
CREATE INDEX idx_auth_events_type       ON auth_events (event_type);
CREATE INDEX idx_auth_events_failed     ON auth_events (created_at DESC) WHERE success = false;

COMMENT ON TABLE  auth_events IS 'Bitácora de autenticación. Adicional a audit_logs. Se exporta a Sentinel.';
COMMENT ON COLUMN auth_events.profile_id IS 'Puede ser NULL si el email no corresponde a un perfil (intento con cuenta inexistente).';
COMMENT ON COLUMN auth_events.metadata   IS 'JSON libre para detalles del evento (id_token claims, etc.).';

GRANT SELECT, INSERT, UPDATE ON auth_events TO abent3t_app;

COMMIT;
