import type { Prisma } from '@prisma/client';
import {
  type AvanceRows,
  buildAvanceData,
  loadAvanceRows,
} from './avance-semanal.data';
import { AVANCE_REGLAS } from './avance-semanal.reglas';

/**
 * H1 — de filas a gestiones: SAP (cerrada, cancelada, cerrada a mano) y las
 * PR de Maximo. K5 (2026-10-05): las PR traen sus fechas reales (primer
 * APPR, ISSUEDATE, último CLOSE y última CAN, K3): ya no hay fechas por
 * folio ni por la primera vez que se vio la PR, y sin la fecha de la regla
 * la PR queda fuera y se cuenta aparte.
 */

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (iso: string) => new Date(iso);

const empty = (): AvanceRows => ({
  sapRequests: [],
  sapFirstPo: [],
  sapOrders: [],
  maximoPrs: [],
  maximoFirstPo: [],
  maximoOrders: [],
});

type PrRow = AvanceRows['maximoPrs'][number];

const pr = (prnum: string, overrides: Partial<PrRow> = {}): PrRow => ({
  prnum,
  pr_status: 'APPR',
  pr_issue_date: T('2026-09-14T15:00:00Z'),
  pr_approved_at: T('2026-09-15T09:00:00Z'),
  pr_closed_at: null,
  pr_cancelled_at: null,
  de_contrato: false,
  ...overrides,
});

describe('fecha de las PR de Maximo (K5: sin folio)', () => {
  it('recibida = primer APPR aunque la PR se haya aprobado dos veces (WAPPR→APPR→WAPPR→APPR)', () => {
    const rows = empty();
    // el mapper (K3) deja en pr_approved_at la PRIMERA APPR; la segunda no la mueve
    rows.maximoPrs = [
      pr('PR990002', {
        pr_issue_date: T('2026-09-14T15:00:00Z'),
        pr_approved_at: T('2026-09-15T09:00:00Z'),
      }),
    ];
    const [g] = buildAvanceData(rows).gestiones;
    expect(AVANCE_REGLAS.recibida).toBe('aprobacion');
    expect(g).toMatchObject({
      sistema: 'maximo',
      folio: 'PR990002',
      recibida: T('2026-09-15T09:00:00Z'),
      fecha_origen: 'aprobacion',
      inicio_dias: T('2026-09-15T09:00:00Z'),
      primera_oc: null,
      cierre_sin_oc: null,
      cancelada: null,
    });
  });

  it("con 'aprobacion' la PR sin APPR queda fuera y se cuenta aparte; con 'emision' entra", () => {
    const rows = empty();
    rows.maximoPrs = [
      pr('PR1'),
      // en aprobación: nunca llegó a Compras
      pr('PR2', { pr_status: 'WAPPR', pr_approved_at: null }),
      // cancelada sin aprobar (STATUS CAN sin fila CAN)
      pr('PR3', { pr_status: 'CAN', pr_approved_at: null }),
      // sin ninguna fecha (antes del primer full)
      pr('PR4', {
        pr_status: null,
        pr_issue_date: null,
        pr_approved_at: null,
      }),
    ];
    const aprobacion = buildAvanceData(rows);
    expect(aprobacion.gestiones.map((g) => g.folio)).toEqual(['PR1']);
    expect(aprobacion.maximo_no_recibidas).toEqual([
      { prnum: 'PR2', emision: T('2026-09-14T15:00:00Z'), pr_status: 'WAPPR' },
      { prnum: 'PR3', emision: T('2026-09-14T15:00:00Z'), pr_status: 'CAN' },
      { prnum: 'PR4', emision: null, pr_status: null },
    ]);

    const emision = buildAvanceData(rows, {
      ...AVANCE_REGLAS,
      recibida: 'emision',
    });
    expect(emision.gestiones.map((g) => g.folio)).toEqual([
      'PR1',
      'PR2',
      'PR3',
    ]);
    expect(emision.gestiones[1]).toMatchObject({
      recibida: T('2026-09-14T15:00:00Z'),
      fecha_origen: 'emision',
      // los días siguen desde la aprobación: sin APPR no hay días
      inicio_dias: null,
    });
    expect(emision.maximo_no_recibidas.map((p) => p.prnum)).toEqual(['PR4']);
    const diasEmision = buildAvanceData(rows, {
      ...AVANCE_REGLAS,
      recibida: 'emision',
      dias_desde: 'emision',
    });
    expect(diasEmision.gestiones[1].inicio_dias).toEqual(
      T('2026-09-14T15:00:00Z'),
    );
  });

  it('cerrada = primera OC o, sin OC, el último CLOSE; cancelada = última CAN; de_contrato pasa', () => {
    const rows = empty();
    rows.maximoPrs = [
      // con OC: la OC manda aunque la PR también tenga CLOSE
      pr('PR10', {
        pr_status: 'CLOSE',
        pr_closed_at: T('2026-09-09T17:20:00Z'),
      }),
      // CLOSE sin OC (H1)
      pr('PR11', {
        pr_status: 'CLOSE',
        pr_closed_at: T('2026-09-20T17:00:00Z'),
      }),
      // cancelada (MEMO en el historial)
      pr('PR12', {
        pr_status: 'CAN',
        pr_cancelled_at: T('2026-09-18T16:40:00Z'),
      }),
      // contrato en APPR con la PR en CLOSE
      pr('PR13', {
        pr_status: 'CLOSE',
        pr_closed_at: T('2026-06-15T12:00:00Z'),
        de_contrato: true,
      }),
    ];
    rows.maximoFirstPo = [
      { prnum: 'PR10', primera_oc: T('2026-09-09T17:20:00Z') },
    ];
    const by = new Map(
      buildAvanceData(rows).gestiones.map((g) => [g.folio, g]),
    );
    expect(by.get('PR10')).toMatchObject({
      primera_oc: T('2026-09-09T17:20:00Z'),
      cierre_sin_oc: null,
    });
    expect(by.get('PR11')).toMatchObject({
      primera_oc: null,
      cierre_sin_oc: T('2026-09-20T17:00:00Z'),
      de_contrato: false,
    });
    expect(by.get('PR12')?.cancelada).toEqual(T('2026-09-18T16:40:00Z'));
    expect(by.get('PR13')).toMatchObject({
      cierre_sin_oc: T('2026-06-15T12:00:00Z'),
      de_contrato: true,
    });
  });
});

describe('buildAvanceData', () => {
  it('SAP: primera OC, cancelada (UpdateDate) y cerrada a mano sin OC', () => {
    const rows = empty();
    rows.sapRequests = [
      {
        doc_entry: 1,
        doc_num: 11,
        doc_date: D('2026-02-01'),
        document_status: 'bost_Close',
        cancelled: false,
        update_date_source: D('2026-02-09'),
      },
      {
        doc_entry: 2,
        doc_num: 12,
        doc_date: D('2026-01-12'),
        document_status: 'bost_Close',
        cancelled: true,
        update_date_source: D('2026-01-20'),
      },
      {
        doc_entry: 3,
        doc_num: 13,
        doc_date: D('2026-03-01'),
        document_status: 'bost_Close',
        cancelled: false,
        update_date_source: D('2026-03-04'),
      },
      {
        doc_entry: 4,
        doc_num: 14,
        doc_date: D('2026-03-02'),
        document_status: 'bost_Open',
        cancelled: false,
        update_date_source: null,
      },
    ];
    rows.sapFirstPo = [{ entry: 1, primera_oc: D('2026-02-05') }];
    const data = buildAvanceData(rows);
    const [conOc, cancelada, aMano, abierta] = data.gestiones;
    expect(conOc).toMatchObject({
      folio: '11',
      fecha_origen: 'documento',
      inicio_dias: D('2026-02-01'),
      primera_oc: D('2026-02-05'),
      cierre_sin_oc: null,
    });
    expect(cancelada.cancelada).toEqual(D('2026-01-20'));
    expect(aMano.cierre_sin_oc).toEqual(D('2026-03-04'));
    expect(abierta).toMatchObject({
      primera_oc: null,
      cierre_sin_oc: null,
      cancelada: null,
    });
    expect(data.sap_desde).toEqual(D('2026-01-12'));
  });

  it('OC por moneda con el subtotal (K6): SAP marca las que cuentan en Maximo; sin subtotal = null', () => {
    const rows = empty();
    rows.sapOrders = [
      {
        fecha: D('2026-01-02'),
        moneda: 'MXN',
        monto: '10.50',
        subtotal: '9.05',
        contada_en_maximo: true,
      },
      {
        fecha: D('2026-01-03'),
        moneda: 'USD',
        monto: null,
        subtotal: null,
        contada_en_maximo: false,
      },
    ];
    rows.maximoOrders = [
      { fecha: D('2026-01-04'), moneda: 'MXN', monto: 7, subtotal: null },
    ];
    const data = buildAvanceData(rows);
    expect(data.ordenes).toEqual([
      {
        sistema: 'sap',
        fecha: D('2026-01-02'),
        moneda: 'MXN',
        monto: 10.5,
        subtotal: 9.05,
        contada_en_maximo: true,
      },
      {
        sistema: 'maximo',
        fecha: D('2026-01-04'),
        moneda: 'MXN',
        monto: 7,
        subtotal: null,
        contada_en_maximo: false,
      },
    ]);
  });
});

describe('loadAvanceRows', () => {
  it('K5: las PR salen de la vista por PR con sus fechas reales y las OC traen el subtotal (sin folio)', async () => {
    const queries: Prisma.Sql[] = [];
    const prisma = {
      $queryRaw: jest.fn((query: Prisma.Sql) => {
        queries.push(query);
        return Promise.resolve([]);
      }),
    };
    await loadAvanceRows(
      prisma as unknown as Parameters<typeof loadAvanceRows>[0],
    );
    expect(queries).toHaveLength(6);
    const sql = queries.map((q) => q.sql).join(' ');
    expect(sql).toContain('bool_or(has_contract) OVER (PARTITION BY prnum)');
    expect(sql).toContain('p.pr_approved_at');
    expect(sql).toContain('p.pr_cancelled_at');
    expect(sql).toContain('s.subtotal');
    expect(sql).toContain('p.subtotal');
    expect(sql).not.toContain('regexp_replace');
    expect(sql).not.toContain('first_seen_at');
  });
});
