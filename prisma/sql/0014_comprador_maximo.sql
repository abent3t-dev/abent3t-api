-- =============================================================================
-- 0014_comprador_maximo.sql — Pedidos de Ingrid 2026-09-25 (E4: comprador)
--
-- Ingrid pidió el nombre del comprador en Expeditación y en los reportes.
--
--   * SAP: sin cambio de esquema. En PRD_ABENT ninguna OC trae comprador
--     (SalesPersonCode = -1 en las 3,379; el catálogo SalesPersons solo tiene
--     "-Ningún empleado-" y DocumentsOwner viene vacío) → se muestra quién
--     capturó la OC ("Capturó: …", ya en created_by_name desde 0012).
--   * Maximo: la OC sí trae al comprador (PO.PURCHASEAGENT) y su PERSON con
--     el nombre completo (DISPLAYNAME). Se guardan aquí; también dan el
--     comprador de las OC de SAP creadas desde Maximo (maximo_ponum).
--
-- Columnas NULLABLES; se llenan con `npm run maximo:remap` (viven en `raw`,
-- no hace falta re-descargar Maximo). Sin cambios en SAP: no requiere sync.
-- =============================================================================

BEGIN;

ALTER TABLE maximo_purchase_orders
  ADD COLUMN purchase_agent      varchar(100),
  ADD COLUMN purchase_agent_name varchar(255);

COMMENT ON COLUMN maximo_purchase_orders.purchase_agent IS
  'Comprador de la OC en Maximo (PO.PURCHASEAGENT, usuario). Se traduce con erp_user_aliases si hay alias.';
COMMENT ON COLUMN maximo_purchase_orders.purchase_agent_name IS
  'DISPLAYNAME de la PERSON de la OC cuando es el PURCHASEAGENT. NULL = sin comprador o sin nombre → se muestra el usuario.';

COMMIT;
