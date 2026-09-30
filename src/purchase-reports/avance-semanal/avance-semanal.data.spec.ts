import {
  type AvanceRows,
  buildAvanceData,
  maximoFolioDater,
  parseFolio,
} from './avance-semanal.data';

/**
 * H1 — de filas a gestiones: SAP (cerrada, cancelada, cerrada a mano) y la
 * fecha aproximada de las PR de Maximo (exacta, alta, folio, sin fecha).
 */

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (iso: string) => new Date(iso);

const empty = (): AvanceRows => ({
  sapRequests: [],
  sapFirstPo: [],
  sapOrders: [],
  maximoPrs: [],
  maximoFirstPo: [],
  maximoKnown: [],
  maximoOrders: [],
});

describe('folio de las PR de Maximo', () => {
  it('toma los dígitos, igual que maximoPrFolio en SQL', () => {
    expect(parseFolio('PR104531')).toBe(104531);
    expect(parseFolio('104531')).toBe(104531);
    expect(parseFolio('PR-A')).toBeNull();
  });

  it('fecha por folio = la más reciente conocida con folio menor o igual (ventana de G3)', () => {
    const dater = maximoFolioDater([
      { folio: 100, fecha: D('2026-01-10') },
      { folio: 120, fecha: D('2026-01-08') }, // fuera de orden
      { folio: 150, fecha: D('2026-02-01') },
    ]);
    expect(dater(99)).toBeNull();
    expect(dater(100)).toEqual(D('2026-01-10'));
    expect(dater(130)).toEqual(D('2026-01-10'));
    expect(dater(900)).toEqual(D('2026-02-01'));
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

  it('Maximo: exacta por su OC, alta después de la carga inicial, folio antes; sin fecha fuera', () => {
    const rows = empty();
    const initial = T('2026-09-22T09:00:00Z');
    rows.maximoKnown = [
      { folio: BigInt(100), fecha: D('2026-09-01') },
      { folio: BigInt(110), fecha: D('2026-09-10') },
    ];
    rows.maximoPrs = [
      // exacta: es el folio de una OC con fecha
      {
        prnum: 'PR100',
        con_contrato: false,
        fecha_contrato: null,
        visto: initial,
      },
      // por folio: vista en la carga inicial
      {
        prnum: 'PR105',
        con_contrato: false,
        fecha_contrato: null,
        visto: initial,
      },
      // alta: vista después de la carga inicial, cerca de su folio
      {
        prnum: 'PR120',
        con_contrato: false,
        fecha_contrato: null,
        visto: T('2026-09-25T15:40:00Z'),
      },
      // vieja que aparece tarde (a más de 30 días de su folio): por folio
      {
        prnum: 'PR101',
        con_contrato: false,
        fecha_contrato: null,
        visto: T('2026-11-20T10:00:00Z'),
      },
      // se volvió contrato
      {
        prnum: 'PR108',
        con_contrato: true,
        fecha_contrato: D('2026-09-15'),
        visto: initial,
      },
      // folio menor a todos los conocidos: sin fecha
      {
        prnum: 'PR050',
        con_contrato: false,
        fecha_contrato: null,
        visto: initial,
      },
    ];
    rows.maximoFirstPo = [{ prnum: 'PR100', primera_oc: D('2026-09-04') }];
    const data = buildAvanceData(rows);
    const by = new Map(data.gestiones.map((g) => [g.folio, g]));
    expect(by.get('PR100')).toMatchObject({
      fecha_origen: 'exacta',
      recibida: D('2026-09-01'),
      primera_oc: D('2026-09-04'),
    });
    expect(by.get('PR105')).toMatchObject({
      fecha_origen: 'folio',
      recibida: D('2026-09-01'),
    });
    expect(by.get('PR120')).toMatchObject({
      fecha_origen: 'alta',
      recibida: T('2026-09-25T15:40:00Z'),
    });
    expect(by.get('PR101')).toMatchObject({
      fecha_origen: 'folio',
      recibida: D('2026-09-01'),
    });
    expect(by.get('PR108')?.cierre_sin_oc).toEqual(D('2026-09-15'));
    expect(by.has('PR050')).toBe(false);
    expect(data.maximo_sin_fecha).toBe(1);
  });

  it('OC por moneda: SAP marca las que cuentan en Maximo', () => {
    const rows = empty();
    rows.sapOrders = [
      {
        fecha: D('2026-01-02'),
        moneda: 'MXN',
        monto: '10.50',
        contada_en_maximo: true,
      },
      {
        fecha: D('2026-01-03'),
        moneda: 'USD',
        monto: null,
        contada_en_maximo: false,
      },
    ];
    rows.maximoOrders = [{ fecha: D('2026-01-04'), moneda: 'MXN', monto: 7 }];
    const data = buildAvanceData(rows);
    expect(data.ordenes).toEqual([
      {
        sistema: 'sap',
        fecha: D('2026-01-02'),
        moneda: 'MXN',
        monto: 10.5,
        contada_en_maximo: true,
      },
      {
        sistema: 'maximo',
        fecha: D('2026-01-04'),
        moneda: 'MXN',
        monto: 7,
        contada_en_maximo: false,
      },
    ]);
  });
});
