-- =============================================================================
-- 0012_sap_saldo_solicitante.sql — Ajustes de Compras 2026-09-23 (Ingrid)
--
--   * Saldo disponible de cada OC de SAP (lo que falta por recibir/facturar,
--     con IVA y en la moneda del documento): open_total.
--   * Solicitante: SAP no tiene Requester en PurchaseOrders; sale de las
--     solicitudes de pedido de las que se copiaron las líneas
--     (base_request_entries → sap_purchase_requests.requester_name). Para
--     las OC sin solicitud se guarda quién la capturó (UserSign + nombre del
--     catálogo Users de SAP).
--   * Las OC que crea la integración Maximo → SAP (U_POID presente) traen el
--     PONUM de Maximo en NumAtCard: maximo_ponum, para leer ahí el
--     solicitante (REQUESTEDBY de la PR de Maximo).
--
-- Columnas NULLABLES (base_request_entries vacío por defecto): se llenan con
-- el sync full de SAP tras desplegar (el mapper sube a 1.2.0 y además
-- corrige los montos en USD/EUR, que venían en MXN).
-- =============================================================================

BEGIN;

ALTER TABLE sap_purchase_orders
  ADD COLUMN open_total           decimal(15, 2),
  ADD COLUMN user_sign            integer,
  ADD COLUMN created_by_name      varchar(255),
  ADD COLUMN maximo_ponum         varchar(50),
  ADD COLUMN base_request_entries integer[] NOT NULL DEFAULT '{}';

COMMIT;
