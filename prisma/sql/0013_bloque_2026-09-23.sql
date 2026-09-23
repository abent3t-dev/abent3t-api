-- =============================================================================
-- 0013_bloque_2026-09-23.sql — Bloque Compras 2026-09-23 (check-in Ingrid)
--
-- Una sola migración con TODOS los cambios de esquema del bloque (menos pasos
-- en el Servidor B). Columnas nuevas NULLABLES: nada se rellena con 0 ni con
-- valores inventados — los datos llegan con `maximo:remap` (viven en `raw`)
-- o con la captura de Compras (alias de usuarios).
--
--   * D6  erp_user_aliases: equivalencias usuario SAP/Maximo → nombre (y,
--         opcionalmente, perfil de la plataforma). Las cargan Ingrid/Alfredo
--         desde Compras → Roles (o por CSV/Excel). Sin alias, todo se ve
--         como hoy (el código del ERP).
--   * D7  maximo_contracts.pr_total: monto de la PR de Maximo (PR.TOTALCOST
--         o suma de PRLINE.LINECOST) cuando la Object Structure lo trae.
--   * D8  maximo_contracts.consumed_value: consumido del contrato
--         (RELEASEDTOTAL / COMMITTED / INVOICEDTOTAL … cuando la OS lo trae).
--         saldo = contract_value - consumed_value, calculado, nunca persistido.
--   * D1  índice sobre sap_purchase_orders.maximo_ponum: las OC migradas de
--         Maximo a SAP se cruzan contra maximo_purchase_orders para no
--         contarlas dos veces (dashboard, reportes, expeditación).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- D6 — Equivalencias de usuarios de SAP y Maximo
-- -----------------------------------------------------------------------------
CREATE TABLE erp_user_aliases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system       varchar(10) NOT NULL CHECK (system IN ('sap', 'maximo')),
  code         varchar(100) NOT NULL,             -- usuario del ERP (CGAZB, AMMD1, jgonzalez…)
  display_name varchar(255) NOT NULL,             -- nombre que se muestra
  profile_id   uuid REFERENCES profiles(id),      -- perfil de la plataforma (opcional)
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES profiles(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_erp_user_alias UNIQUE (system, code)
);

CREATE INDEX idx_erp_user_aliases_profile ON erp_user_aliases (profile_id);

COMMENT ON TABLE erp_user_aliases IS
  'Equivalencias usuario de SAP/Maximo → nombre (y perfil). Solo presentación: los códigos del ERP se conservan en staging.';
COMMENT ON COLUMN erp_user_aliases.code IS
  'Código tal como llega del ERP (CHANGEBY/REQUESTEDBY de Maximo; user_name/Requester de SAP). Se compara sin distinguir mayúsculas.';

GRANT SELECT, INSERT, UPDATE, DELETE ON erp_user_aliases TO abent3t_app;

-- -----------------------------------------------------------------------------
-- D7 / D8 — Maximo: monto de la PR y consumido del contrato
-- -----------------------------------------------------------------------------
ALTER TABLE maximo_contracts
  ADD COLUMN pr_total       numeric(15,2),
  ADD COLUMN consumed_value numeric(15,2);

COMMENT ON COLUMN maximo_contracts.pr_total IS
  'Monto de la PR (PR.TOTALCOST o suma de PRLINE.LINECOST). NULL = la Object Structure no lo expone → "No disponible" (nunca 0). Se rellena con maximo:remap.';
COMMENT ON COLUMN maximo_contracts.consumed_value IS
  'Consumido del contrato (primera llave disponible: RELEASEDTOTAL, RELEASEDCOST, COMMITTED, INVOICEDTOTAL, TOTALRELEASED). NULL = no expuesto → "No disponible". Saldo = contract_value - consumed_value, calculado.';

-- -----------------------------------------------------------------------------
-- D1 — OC migradas de Maximo a SAP: cruce contra maximo_purchase_orders
-- -----------------------------------------------------------------------------
CREATE INDEX idx_sap_po_maximo_ponum ON sap_purchase_orders (maximo_ponum)
  WHERE maximo_ponum IS NOT NULL;

COMMIT;
