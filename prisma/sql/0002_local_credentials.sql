-- =============================================================================
-- 0002_local_credentials.sql
-- Tabla de credenciales locales para fallback email+password (K-8 del AUDIT).
--
-- CONTEXTO:
--   Durante desarrollo, hasta que TI de Abent 3T entregue las credenciales de
--   Microsoft Entra ID, el login no puede depender solo del flujo OIDC. Por
--   eso se mantiene un segundo path: email + password contra esta tabla, que
--   emite el MISMO JWT propio que el flujo OIDC.
--
--   Una vez en producción con Entra ID listo, este path se deshabilita por
--   env (ALLOW_LOCAL_LOGIN=false). La tabla puede permanecer en BD para no
--   romper migraciones, o puede eliminarse — decisión operativa, no técnica.
--
--   NOTA SEGURIDAD:
--   * password_hash es bcrypt (rounds >= 10).
--   * Nunca se almacena la contraseña en claro.
--   * profile_id es la PK Y la FK a profiles — un perfil tiene a lo más una
--     credencial local.
--   * failed_attempts/locked_until permiten implementar rate limiting de
--     intentos fallidos en el service (no en BD).
--
-- Ver: documentation/MIGRATION.md §3 y MIGRATION_AUDIT.md §N (K-8).
-- =============================================================================

BEGIN;

CREATE TABLE local_credentials (
  profile_id        uuid PRIMARY KEY,
  password_hash     text NOT NULL,
  password_set_at   timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz,
  failed_attempts   integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT local_credentials_profile_id_fkey
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX idx_local_credentials_active ON local_credentials (is_active) WHERE is_active = true;
CREATE INDEX idx_local_credentials_locked ON local_credentials (locked_until) WHERE locked_until IS NOT NULL;

COMMENT ON TABLE  local_credentials IS 'Credenciales para fallback email+password (K-8). Solo activo cuando ALLOW_LOCAL_LOGIN=true.';
COMMENT ON COLUMN local_credentials.password_hash IS 'bcrypt hash (rounds >= 10). Nunca contraseña en claro.';
COMMENT ON COLUMN local_credentials.failed_attempts IS 'Conteo de intentos fallidos consecutivos; resetear en login exitoso.';
COMMENT ON COLUMN local_credentials.locked_until IS 'Si NOT NULL y > now(), el login falla aunque la contraseña sea correcta.';
COMMENT ON COLUMN local_credentials.must_change_password IS 'Cuando admin_rh resetea la contraseña, marca este flag; el front fuerza el cambio.';

GRANT SELECT, INSERT, UPDATE, DELETE ON local_credentials TO abent3t_app;

COMMIT;
