import { readFileSync } from 'fs';
import { join } from 'path';
import {
  andBetween,
  CURRENT_MAXIMO_PRS,
  maximoContractPrPending,
  maximoGestionSql,
  maximoPrApprovedWithPo,
  maximoPrInApproval,
  maximoPoMonto,
  maximoPrLlegada,
  maximoPrPending,
  montoBaseNota,
  poSubtotalColumns,
  sapGestionSql,
  sapPoMonto,
  TABLERO_MONTO_BASE,
} from './erp-views.sql';

/**
 * K4 (2026-10-05) — definiciones por PR de Maximo. Sin BD en las pruebas:
 * se pinza el SQL que arman los helpers (el chequeo con los fixtures
 * sembrados de K3.8 se hace en dev). Texto normalizado a un espacio.
 */
const text = (sql: { sql: string }) => sql.sql.replace(/\s+/g, ' ');
/** La condición propia, antes de la subconsulta de PR con OC. */
const head = (sql: string) => sql.slice(0, sql.indexOf(' IN ('));

describe('K4: definiciones por PR de Maximo', () => {
  it('pendiente = estatus DE LA PR en APPR, sin contrato y sin OC vigente (un contrato APPR con la PR en CLOSE no entra)', () => {
    const pending = text(maximoPrPending('p'));
    expect(pending).toContain("p.pr_status = 'APPR'");
    expect(pending).toContain('NOT p.de_contrato');
    expect(pending).toContain('p.prnum NOT IN (');
    // fuera de la subconsulta de OC: nunca el estatus del contrato
    // (`status`), que puede seguir en APPR, ni el folio
    const own = head(pending);
    expect(own).not.toMatch(/\bstatus\b/);
    expect(own).not.toContain('has_contract');
    expect(pending).not.toContain('regexp_replace');
  });

  it('I8: de contrato = APPR con contrato y sin OC; con OC = APPR con OC: las tres juntas son todas las APPR', () => {
    const pending = text(maximoPrPending('p'));
    const contract = text(maximoContractPrPending('p'));
    const withPo = text(maximoPrApprovedWithPo('p'));
    for (const sql of [pending, contract, withPo]) {
      expect(sql).toContain("p.pr_status = 'APPR'");
    }
    // partición: sin OC (con y sin contrato) y con OC, con la misma subconsulta
    expect(contract).toContain('AND p.de_contrato');
    expect(contract).not.toContain('NOT p.de_contrato');
    expect(contract).toContain('p.prnum NOT IN (');
    expect(withPo).toContain('p.prnum IN (');
    expect(head(withPo)).not.toContain('NOT');
    const subquery = (sql: string) => sql.slice(sql.indexOf(' IN (') + 5);
    expect(subquery(withPo)).toBe(subquery(pending));
    expect(subquery(contract)).toBe(subquery(pending));
  });

  it('en aprobación = WAPPR de la PR (aparte; no es el `maximoInApproval` de OC)', () => {
    expect(text(maximoPrInApproval('p'))).toBe("(p.pr_status = 'WAPPR')");
  });

  it('llegada a Compras FIJA = primer APPR o, sin APPR, la emisión; erp-views no lee AVANCE_REGLAS', () => {
    expect(text(maximoPrLlegada('c'))).toBe(
      'coalesce(c.pr_approved_at, c.pr_issue_date)',
    );
    // criterio por grep: nada de purchase-reports (donde vive el avance)
    const source = readFileSync(join(__dirname, 'erp-views.sql.ts'), 'utf8');
    expect(source).not.toMatch(/from '[^']*purchase-reports/);
    expect(source).not.toMatch(/import[^;]*AVANCE_REGLAS/);
  });

  it('CURRENT_MAXIMO_PRS: una fila por PR y sin obsoletas (la fila vieja no duplica la PR)', () => {
    const view = text(CURRENT_MAXIMO_PRS);
    expect(view).toContain('DISTINCT ON (prnum)');
    expect(view).toContain('superseded_at IS NULL');
    expect(view).toContain(
      'bool_or(has_contract) OVER (PARTITION BY prnum) AS de_contrato',
    );
  });

  it('andBetween: [from, toExcl) con límites abiertos', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2027-01-01T00:00:00Z');
    const both = andBetween(maximoPrLlegada('p'), from, to);
    expect(text(both)).toBe(
      'AND coalesce(p.pr_approved_at, p.pr_issue_date) >= ? AND coalesce(p.pr_approved_at, p.pr_issue_date) < ?',
    );
    expect(both.values).toEqual([from, to]);
    expect(andBetween(maximoPrLlegada('p'), from, null).values).toEqual([from]);
    expect(text(andBetween(maximoPrLlegada('p'), null, null)).trim()).toBe('');
  });
});

describe('K4.3: G2 de Maximo (maximoGestionSql)', () => {
  it('fecha de la OC − coalesce(PR de la línea, la más antigua de sus PR en la vista por PR); más el dato desde la aprobación', () => {
    const sql = text(maximoGestionSql(null, null));
    // la fecha de AB_CONTRATOS cubre las OC cuya línea no trae la de su PR
    expect(sql).toContain('coalesce(oc.pr_issue_date, f.emision)');
    expect(sql).toContain('unnest(oc.pr_nums)');
    expect(sql).toContain('min(p.pr_issue_date) AS emision');
    expect(sql).toContain('DISTINCT ON (prnum)');
    expect(sql).toContain('superseded_at IS NULL');
    // dato secundario: desde el primer APPR más antiguo de sus PR
    expect(sql).toContain('min(p.pr_approved_at) AS aprobacion');
    expect(sql).toContain('AS dias_desde_aprobacion');
    // OC vigentes no canceladas; LEFT JOIN: la OC sin PR conocida sigue (dias null)
    expect(sql).toContain("NOT IN ('CAN', 'CANCEL')");
    expect(sql).toContain('FROM oc LEFT JOIN fechas f');
  });

  it('el periodo va por la fecha de la OC (`created_at_source`)', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2027-01-01T00:00:00Z');
    const sql = maximoGestionSql(from, to);
    expect(text(sql)).toContain(
      'AND v.created_at_source >= ? AND v.created_at_source < ?',
    );
    expect(sql.values).toEqual([from, to]);
    expect(maximoGestionSql(null, null).values).toEqual([]);
  });

  it('M2: trae el PONUM, PURCHASEAGENT y creador de cada OC para agrupar por comprador (los días no cambian)', () => {
    const sql = text(maximoGestionSql(null, null));
    expect(sql).toContain(
      'AS dias_desde_aprobacion, oc.ponum, oc.purchase_agent, oc.purchase_agent_name, oc.created_by FROM oc LEFT JOIN fechas f',
    );
  });
});

describe('M2: G2 de SAP (sapGestionSql), la misma consulta para el tablero y Órdenes', () => {
  it('OC no canceladas que nacieron de una solicitud, con quien la capturó y su PONUM; sin D1 (G2 es por sistema)', () => {
    const sql = text(sapGestionSql(null, null));
    expect(sql).toContain(
      'SELECT doc_entry, doc_date, base_request_entries, created_by_name, maximo_ponum FROM sap_purchase_orders',
    );
    expect(sql).toContain('cancelled IS DISTINCT FROM true');
    expect(sql).toContain('cardinality(base_request_entries) > 0');
    expect(sql).not.toContain('EXISTS');
    expect(sapGestionSql(null, null).values).toEqual([]);
  });

  it('el periodo va por la fecha de la OC (`doc_date`), [from, toExcl)', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2027-01-01T00:00:00Z');
    const sql = sapGestionSql(from, to);
    expect(text(sql)).toContain('AND doc_date >= ? AND doc_date < ?');
    expect(sql.values).toEqual([from, to]);
  });
});

describe('K6: dos bases de montos de OC', () => {
  it('TABLERO_MONTO_BASE sigue con IVA hasta que conteste Ingrid', () => {
    expect(TABLERO_MONTO_BASE).toBe('con_iva');
  });

  it('con IVA = DocTotal / TOTALCOST; sin IVA = subtotal (suma de las líneas) en las dos fuentes', () => {
    expect(text(sapPoMonto('s', 'con_iva'))).toBe('s.doc_total');
    expect(text(sapPoMonto('s', 'sin_iva'))).toBe('s.subtotal');
    expect(text(maximoPoMonto('c', 'con_iva'))).toBe('c.total_cost');
    expect(text(maximoPoMonto('c', 'sin_iva'))).toBe('c.subtotal');
  });

  it('poSubtotalColumns: suma de los subtotales y cuántas OC no lo tienen (no se estiman)', () => {
    expect(text(poSubtotalColumns('c'))).toBe(
      'coalesce(sum(c.subtotal), 0) AS subtotal, count(*) FILTER (WHERE c.subtotal IS NULL)::int AS sin_subtotal',
    );
  });

  it('montoBaseNota dice la base (reemplaza los "con IVA" fijos)', () => {
    expect(montoBaseNota('con_iva')).toMatch(/^con IVA/);
    expect(montoBaseNota('sin_iva')).toMatch(/^sin IVA/);
    expect(montoBaseNota('sin_iva')).toContain('sin subtotal no suman');
  });
});
