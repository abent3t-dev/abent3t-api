-- =============================================================================
-- 0016_bloque_2026-09-28.sql — Reunión con Ingrid del 2026-09-28 (G2, G3, G6)
--
-- Una sola migración para todo el bloque. Los datos NO se rellenan aquí: ya
-- viven en el `raw` de cada OC y los derivan el mapper 2026.09.28-1 y
-- `npm run maximo:remap -- purchase_orders` (sin llamadas a Maximo).
--
--   * G2  maximo_purchase_orders.pr_issue_date: fecha de creación de la
--         solicitud (PR.ISSUEDATE) de la OC; con varias PR, la más antigua.
--         Días de gestión Maximo = fecha de la OC − pr_issue_date. NULL = OC
--         sin solicitud (queda fuera del promedio y se refleja en la N).
--   * G3  maximo_purchase_orders.pr_nums: PRNUM de todas las líneas de la OC.
--         "Pendiente de gestionar" = PR que no aparece en ninguna OC vigente.
--   * G6  maximo_po_status_history: historial POSTATUS de cada fila de
--         staging (una fila por revisión de la OC). Da la cadena de
--         aprobación (WAPPR → APPR1..n → APPR), los tiempos por aprobador y
--         los pendientes por nivel. Lo reescriben staging y remap.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- G2 / G3 — Solicitud (PR) de cada OC de Maximo
-- -----------------------------------------------------------------------------
ALTER TABLE maximo_purchase_orders
  ADD COLUMN pr_issue_date timestamptz,
  ADD COLUMN pr_nums       text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN maximo_purchase_orders.pr_issue_date IS
  'PR.ISSUEDATE de la solicitud de la OC (la más antigua si hay varias). NULL = OC sin solicitud. Días de gestión = created_at_source − pr_issue_date. Se llena con maximo:remap.';
COMMENT ON COLUMN maximo_purchase_orders.pr_nums IS
  'PRNUM de las líneas de la OC (distintos, ordenados). Una PR que no aparece en ninguna OC vigente está pendiente de gestionar. Se llena con maximo:remap.';

CREATE INDEX idx_maximo_po_pr_nums ON maximo_purchase_orders USING gin (pr_nums);

-- -----------------------------------------------------------------------------
-- G6 — Historial de estatus (POSTATUS) por fila de staging
-- -----------------------------------------------------------------------------
CREATE TABLE maximo_po_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id       uuid NOT NULL REFERENCES maximo_purchase_orders(id) ON DELETE CASCADE,
  ponum       varchar(50) NOT NULL,
  siteid      varchar(20),
  revisionnum int,
  seq         int NOT NULL,             -- orden del cambio (CHANGEDATE, desempate POSTATUSID)
  status      varchar(30) NOT NULL,
  change_date timestamptz,
  changed_by  varchar(100),             -- usuario de Maximo (CHANGEBY)
  CONSTRAINT uq_maximo_po_status_history UNIQUE (po_id, seq)
);

CREATE INDEX idx_maximo_po_hist_ponum       ON maximo_po_status_history (ponum);
CREATE INDEX idx_maximo_po_hist_status_date ON maximo_po_status_history (status, change_date);
CREATE INDEX idx_maximo_po_hist_changed_by  ON maximo_po_status_history (changed_by);

COMMENT ON TABLE maximo_po_status_history IS
  'POSTATUS de cada revisión de OC de Maximo (derivado del raw; lo reescriben staging y remap). WAPPR = envío a aprobación; APPRn = aprobación del nivel n; APPR = aprobación final; APPRnREV = aprobación de una revisión en el nivel n.';

GRANT SELECT, INSERT, UPDATE, DELETE ON maximo_po_status_history TO abent3t_app;

COMMIT;
