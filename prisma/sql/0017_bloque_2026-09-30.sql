-- =============================================================================
-- 0017_bloque_2026-09-30.sql — Go-live con el equipo de Compras (I1b, I6, I9)
--
-- Una sola migración para todo el bloque; no rellena datos.
--
--   * I6  Base real de contratos (Control_de_contratos_A3T.xlsx):
--         - start_date / end_date pasan a NULL: hay documentos permanentes,
--           "por servicio" o sin fecha. Sin fecha de fin no hay alertas.
--         - carpeta (A3T-0003): agrupa el contrato con su carta de intención,
--           enmiendas y convenios; contract_number = carpeta + sufijo del tipo.
--         - document_label: el tipo literal del archivo ("Enmienda 3").
--         - user_area: el área usuaria responsable (11 áreas de su catálogo).
--   * I1b maximo_purchase_orders.receipt_status: recepción de la OC en Maximo
--         (RECEIPTS: NONE / PARTIAL / COMPLETE). NULL mientras CIISA no la
--         exponga en AB_COMPRAS; la regla de Expeditación se activa sola.
--   * I9  raw_hash en maximo_purchase_orders y maximo_contracts: hash del
--         payload recibido. "Sin cambio" = mismo rowstamp Y mismo hash Y misma
--         versión del mapper; así los campos que CIISA agregue llegan también
--         a lo ya sincronizado en el siguiente full, sin pasos manuales. Las
--         filas existentes arrancan en NULL y se llenan en el primer full.
-- =============================================================================

BEGIN;

ALTER TABLE contracts
  ALTER COLUMN start_date DROP NOT NULL,
  ALTER COLUMN end_date DROP NOT NULL,
  ADD COLUMN carpeta varchar(20),
  ADD COLUMN document_label varchar(60),
  ADD COLUMN user_area varchar(60);

CREATE INDEX idx_contracts_carpeta ON contracts (carpeta);

COMMENT ON COLUMN contracts.carpeta IS
  'I6: carpeta del control de contratos (A3T-0003); agrupa contrato, carta de intención, enmiendas y convenios';
COMMENT ON COLUMN contracts.document_label IS
  'I6: tipo de documento literal del archivo (Contrato, Enmienda 3, Carta de intención…)';
COMMENT ON COLUMN contracts.user_area IS
  'I6: área usuaria responsable del contrato (catálogo de Compras)';

ALTER TABLE maximo_purchase_orders
  ADD COLUMN receipt_status varchar(20),
  ADD COLUMN raw_hash varchar(64);

ALTER TABLE maximo_contracts
  ADD COLUMN raw_hash varchar(64);

COMMENT ON COLUMN maximo_purchase_orders.receipt_status IS
  'I1b: recepción en Maximo (RECEIPTS o derivada de POLINE.RECEIPTSCOMPLETE): NONE, PARTIAL o COMPLETE';
COMMENT ON COLUMN maximo_purchase_orders.raw_hash IS
  'I9: sha256 del payload recibido; con el rowstamp decide si la fila cambió';
COMMENT ON COLUMN maximo_contracts.raw_hash IS
  'I9: sha256 del payload recibido; con los rowstamp decide si la fila cambió';

COMMIT;
