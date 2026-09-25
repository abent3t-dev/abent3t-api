-- =============================================================================
-- 0015_capturo_maximo.sql — Post-deploy 2026-09-25 (F1: comprador de respaldo)
--
-- En prod solo 11 de 5,008 OC de Maximo traen PURCHASEAGENT, así que el
-- comprador salía vacío en la mayoría (y en las OC de SAP creadas desde
-- Maximo, que lo heredan). Como en SAP, el respaldo es quién creó la OC:
-- el CHANGEBY del PRIMER estatus de su historial (POSTATUS), que ya viene
-- en el `raw`. Se muestra "Capturó: <nombre>" (alias de Compras o usuario).
--
-- Columna NULLABLE; se llena con `npm run maximo:remap -- purchase_orders`
-- (mapper 2026.09.25-2). Sin cambios en SAP: no requiere sync.
-- =============================================================================

BEGIN;

ALTER TABLE maximo_purchase_orders
  ADD COLUMN created_by varchar(100);

COMMENT ON COLUMN maximo_purchase_orders.created_by IS
  'Usuario de Maximo que creó la OC (CHANGEBY del primer POSTATUS). Respaldo del comprador cuando no hay PURCHASEAGENT ("Capturó: …"); se traduce con erp_user_aliases.';

COMMIT;
