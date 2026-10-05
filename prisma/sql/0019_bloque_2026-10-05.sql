-- =============================================================================
-- 0019_bloque_2026-10-05.sql — Campos nuevos de Maximo de CIISA (bloque K)
--
-- Una sola migración; NO rellena datos. Todo ya vive en el `raw` (la sync del
-- 2-oct 22:04 UTC lo reescribió gracias a I9). Lo derivan el mapper de Maximo
-- 2026.10.05-1 en el primer full (K8: 'remapped', sin tocar last_changed_at)
-- y el mapper de SAP 1.3.0 con un full de OC.
--
--   * K2 maximo_purchase_orders.integration_status: PO.PO5 literal (text).
--   * K6 subtotal SIN IVA en la moneda del documento (Maximo: suma de
--        POLINE.LINECOST; SAP: suma de las líneas). NULL si no hay líneas o a
--        alguna le falta importe. total_cost y doc_total siguen con IVA.
--   * K3 maximo_contracts: estatus y fechas de la PR (raíz de AB_CONTRATOS),
--        aparte del estatus del contrato; se repiten en cada revisión.
--   * K3 maximo_pr_status_history: historial PRSTATUS, UNA vez por PR.
--   * K8 maximo_contracts.superseded_at: revisión que ya no viene en el
--        registro de su PR; las vistas la excluyen.
--        maximo_sync_runs.records_remapped: re-mapeos que no son cambio real.
-- =============================================================================

BEGIN;

-- K2 / K6 — OC de Maximo
ALTER TABLE maximo_purchase_orders
  ADD COLUMN integration_status text,
  ADD COLUMN subtotal           numeric(15,2);

CREATE INDEX idx_maximo_po_integration_status
  ON maximo_purchase_orders (integration_status);

COMMENT ON COLUMN maximo_purchase_orders.integration_status IS
  'K2: PO.PO5 literal = estado de integración con SAP (PROCESADO, ACTUALIZAR, ERROR, AGREGAR…). NULL = sin dato.';
COMMENT ON COLUMN maximo_purchase_orders.subtotal IS
  'K6: sin IVA = suma de POLINE.LINECOST (moneda de la OC). NULL si no hay líneas o a alguna le falta LINECOST.';

-- K6 — OC de SAP
ALTER TABLE sap_purchase_orders
  ADD COLUMN subtotal numeric(15,2);

COMMENT ON COLUMN sap_purchase_orders.subtotal IS
  'K6: sin IVA = suma de las líneas (LineTotal en MXN, RowTotalFC en otra moneda). NULL si no hay líneas o a alguna le falta importe.';

-- K3 / K8 — PR de Maximo (raíz de AB_CONTRATOS)
ALTER TABLE maximo_contracts
  ADD COLUMN pr_status       varchar(30),
  ADD COLUMN pr_status_date  timestamptz,
  ADD COLUMN pr_issue_date   timestamptz,
  ADD COLUMN pr_approved_at  timestamptz,
  ADD COLUMN pr_approved_by  varchar(100),
  ADD COLUMN pr_closed_at    timestamptz,
  ADD COLUMN pr_cancelled_at timestamptz,
  ADD COLUMN pr_cancelled_by varchar(100),
  ADD COLUMN superseded_at   timestamptz;

CREATE INDEX idx_maximo_contract_prnum         ON maximo_contracts (prnum);
CREATE INDEX idx_maximo_contract_pr_status     ON maximo_contracts (pr_status);
CREATE INDEX idx_maximo_contract_pr_issue_date ON maximo_contracts (pr_issue_date);

COMMENT ON COLUMN maximo_contracts.pr_status IS
  'K3: PR.STATUS (WAPPR, APPR, CLOSE, CAN). Distinto de status, que es el del contrato (o el de la PR si no hay contrato).';
COMMENT ON COLUMN maximo_contracts.pr_status_date IS 'K3: PR.STATUSDATE.';
COMMENT ON COLUMN maximo_contracts.pr_issue_date IS 'K3: PR.ISSUEDATE (creación de la PR).';
COMMENT ON COLUMN maximo_contracts.pr_approved_at IS
  'K3: CHANGEDATE de la PRIMERA PRSTATUS=APPR = llegada a Compras. NULL = sin APPR en el historial.';
COMMENT ON COLUMN maximo_contracts.pr_approved_by IS 'K3: CHANGEBY de esa primera APPR.';
COMMENT ON COLUMN maximo_contracts.pr_closed_at IS 'K3: CHANGEDATE de la última PRSTATUS=CLOSE.';
COMMENT ON COLUMN maximo_contracts.pr_cancelled_at IS
  'K3: CHANGEDATE de la última PRSTATUS=CAN del historial. NULL si no hay fila CAN (sin respaldo por STATUSDATE).';
COMMENT ON COLUMN maximo_contracts.pr_cancelled_by IS 'K3: CHANGEBY de esa CAN (quién canceló).';
COMMENT ON COLUMN maximo_contracts.superseded_at IS
  'K8: la revisión ya no viene en el registro de su PR (fila sin contrato vieja o revisión retirada). Las vistas la excluyen; se limpia si reaparece.';

-- K8 — Contador de re-mapeos sin cambio real
ALTER TABLE maximo_sync_runs
  ADD COLUMN records_remapped int NOT NULL DEFAULT 0;

COMMENT ON COLUMN maximo_sync_runs.records_remapped IS
  'K8: filas con el mismo rowstamp re-mapeadas por mapper o hash nuevos; no tocan last_changed_at.';

-- K3 — Historial PRSTATUS, una vez por PR
CREATE TABLE maximo_pr_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prnum       varchar(50) NOT NULL,
  siteid      varchar(20),
  seq         int NOT NULL,             -- orden del cambio (CHANGEDATE, desempate PRSTATUSID)
  status      varchar(30) NOT NULL,
  change_date timestamptz,
  changed_by  varchar(100),             -- usuario de Maximo (CHANGEBY)
  memo        text,                     -- MEMO (p. ej. motivo de la cancelación)
  CONSTRAINT uq_maximo_pr_status_history UNIQUE (prnum, seq)
);

CREATE INDEX idx_maximo_pr_hist_status_date ON maximo_pr_status_history (status, change_date);
CREATE INDEX idx_maximo_pr_hist_changed_by  ON maximo_pr_status_history (changed_by);

COMMENT ON TABLE maximo_pr_status_history IS
  'PRSTATUS de cada PR de Maximo (AB_CONTRATOS), una vez por PR, sin FK. Derivado del raw; lo reescriben staging y remap. WAPPR = en aprobación; APPR = aprobada (llega a Compras); CLOSE = cerrada; CAN = cancelada.';

GRANT SELECT, INSERT, UPDATE, DELETE ON maximo_pr_status_history TO abent3t_app;

COMMIT;
