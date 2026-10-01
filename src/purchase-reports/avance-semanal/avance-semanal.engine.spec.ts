import {
  type AvanceData,
  avanceDefiniciones,
  buildAvancePage,
  cohortes,
  estadoAl,
  etiquetaSemana,
  firstMondayOfYear,
  fuentesDelReporte,
  type Gestion,
  isoDay,
  lastCompleteWeek,
  mondayOf,
  montosAdjudicados,
  type OrdenMonto,
  semanaStats,
  weeksBetween,
} from './avance-semanal.engine';

/**
 * H1 (2026-09-29) — motor del reporte de avance semanal con fixtures:
 * límites de semana, cohortes al corte, canceladas, PR de Maximo sin OC y
 * montos por mes.
 */

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (iso: string) => new Date(iso);

const sap = (overrides: Partial<Gestion>): Gestion => ({
  sistema: 'sap',
  folio: '1',
  recibida: D('2026-09-01'),
  fecha_origen: 'exacta',
  primera_oc: null,
  cierre_sin_oc: null,
  cancelada: null,
  ...overrides,
});

const maximo = (overrides: Partial<Gestion>): Gestion =>
  sap({ sistema: 'maximo', folio: 'PR1', ...overrides });

const data = (
  gestiones: Gestion[],
  ordenes: OrdenMonto[] = [],
): AvanceData => ({
  gestiones,
  ordenes,
  maximo_sin_fecha: 0,
  sap_desde: D('2026-01-12'),
});

describe('semanas', () => {
  it('lunes de la semana (el domingo es de la semana que empezó el lunes anterior)', () => {
    expect(isoDay(mondayOf(D('2026-09-21')))).toBe('2026-09-21');
    expect(isoDay(mondayOf(T('2026-09-27T23:59:00Z')))).toBe('2026-09-21');
    expect(isoDay(mondayOf(D('2026-09-28')))).toBe('2026-09-28');
  });

  it('por default la última semana completa; el acumulado va de la más nueva a la más vieja', () => {
    expect(isoDay(lastCompleteWeek(T('2026-09-30T12:00:00Z')))).toBe(
      '2026-09-21',
    );
    expect(weeksBetween(D('2026-09-02'), D('2026-09-21')).map(isoDay)).toEqual([
      '2026-09-21',
      '2026-09-14',
      '2026-09-07',
      '2026-08-31',
    ]);
    expect(isoDay(firstMondayOfYear(2026))).toBe('2026-01-05');
    expect(isoDay(firstMondayOfYear(2024))).toBe('2024-01-01');
  });

  it('etiqueta de lunes a viernes, como la de Jorge', () => {
    expect(etiquetaSemana(D('2026-09-21'))).toBe(
      'Semana del 21 al 25 de septiembre de 2026',
    );
    expect(etiquetaSemana(D('2026-08-31'))).toBe(
      'Semana del 31 de agosto al 4 de septiembre de 2026',
    );
    expect(etiquetaSemana(D('2025-12-29'))).toBe(
      'Semana del 29 de diciembre de 2025 al 2 de enero de 2026',
    );
  });
});

describe('estado de una gestión al corte', () => {
  const asOf = T('2026-09-27T23:59:59.999Z').getTime();

  it('cerrada con su primera OC; si la OC es de otra semana posterior, sigue abierta', () => {
    expect(estadoAl(sap({ primera_oc: D('2026-09-10') }), asOf)).toMatchObject({
      estado: 'cerrada',
      con_oc: true,
    });
    expect(estadoAl(sap({ primera_oc: D('2026-09-28') }), asOf).estado).toBe(
      'abierta',
    );
  });

  it('OC capturada antes que la solicitud: cierra cuando se recibe', () => {
    const e = estadoAl(
      sap({ recibida: D('2026-09-10'), primera_oc: D('2026-09-01') }),
      asOf,
    );
    expect(e.fecha).toBe(D('2026-09-10').getTime());
  });

  it('SAP: cancelada o cerrada a mano sin OC; Maximo sin OC no es abierta ni cancelada', () => {
    expect(estadoAl(sap({ cancelada: D('2026-09-05') }), asOf).estado).toBe(
      'cancelada',
    );
    expect(
      estadoAl(sap({ cierre_sin_oc: D('2026-09-05') }), asOf),
    ).toMatchObject({ estado: 'cerrada', con_oc: false });
    expect(estadoAl(maximo({}), asOf).estado).toBe('sin_oc');
  });
});

describe('cohortes por año al corte', () => {
  const asOf = T('2026-09-27T23:59:59.999Z').getTime();
  const gestiones = [
    // 2026: 2 cerradas (5 y 11 días), 1 cancelada (4 días), 1 abierta, 1 sin OC
    sap({ recibida: D('2026-09-01'), primera_oc: D('2026-09-06') }),
    sap({ recibida: D('2026-09-01'), primera_oc: D('2026-09-12') }),
    sap({ recibida: D('2026-09-01'), cancelada: D('2026-09-05') }),
    sap({ recibida: D('2026-09-20') }),
    maximo({ recibida: D('2026-09-02') }),
    // cierra después del corte: al corte sigue abierta
    sap({ recibida: D('2026-09-03'), primera_oc: D('2026-10-02') }),
    // recibida después del corte: no entra
    sap({ recibida: D('2026-09-29') }),
    // 2025, cerrada en 2026
    maximo({ recibida: D('2025-12-20'), primera_oc: D('2026-01-08') }),
  ];

  it('recibidas del año y, de esas, cerradas / canceladas / abiertas / sin OC', () => {
    const [y2025, y2026] = cohortes(gestiones, [2025, 2026], asOf);
    expect(y2026).toMatchObject({
      recibidas: 6,
      cerradas: 2,
      canceladas: 1,
      abiertas: 2,
      sin_oc: 1,
      atendidas: 3,
      atendidas_pct: 50,
    });
    expect(y2026.dias_cierre).toEqual({
      promedio_dias: 8,
      mediana_dias: 8,
      total: 2,
    });
    expect(y2026.dias_cancelacion.promedio_dias).toBe(4);
    expect(y2025).toMatchObject({ recibidas: 1, cerradas: 1 });
  });

  it('la misma gestión, vista al corte de una semana anterior, todavía no cerraba', () => {
    const early = T('2026-09-06T00:00:00Z').getTime() - 1;
    const [y2026] = cohortes(gestiones, [2026], early);
    expect(y2026.cerradas).toBe(0);
    expect(y2026.abiertas).toBe(3);
  });
});

describe('lo que pasó en la semana', () => {
  it('nuevas (y aproximadas), cerradas de cualquier año y sus días', () => {
    const s = semanaStats(
      [
        sap({ recibida: D('2026-09-22'), primera_oc: D('2026-09-24') }),
        maximo({ recibida: D('2026-09-23'), fecha_origen: 'folio' }),
        maximo({ recibida: D('2025-11-03'), primera_oc: D('2026-09-25') }),
        sap({ recibida: D('2026-09-01'), cancelada: D('2026-09-26') }),
        // cerrada la semana anterior: no es de esta semana
        sap({ recibida: D('2026-09-01'), primera_oc: D('2026-09-20') }),
      ],
      D('2026-09-21'),
    );
    expect(s).toMatchObject({
      lunes: '2026-09-21',
      etiqueta: 'al 25 de septiembre',
      nuevas: 2,
      nuevas_aproximadas: 1,
      cerradas: 2,
      cerradas_anteriores: 1,
      canceladas: 1,
    });
    expect(s.dias_cierre.total).toBe(2);
    expect(s.dias_cancelacion.promedio_dias).toBe(25);
  });
});

describe('montos adjudicados', () => {
  const o = (
    sistema: OrdenMonto['sistema'],
    fecha: string,
    monto: number,
    extra: Partial<OrdenMonto> = {},
  ): OrdenMonto => ({
    sistema,
    fecha: D(fecha),
    moneda: 'MXN',
    monto,
    contada_en_maximo: false,
    ...extra,
  });
  const ordenes = [
    o('maximo', '2026-01-15', 100),
    o('sap', '2026-01-20', 50.555),
    o('sap', '2026-02-02', 999, { contada_en_maximo: true }),
    o('sap', '2026-02-03', 10, { moneda: 'USD' }),
    o('maximo', '2026-10-01', 7), // después del corte
    o('maximo', '2025-12-31', 5), // otro año
  ];
  const asOf = T('2026-09-27T23:59:59.999Z').getTime();

  it('por mes y moneda, hasta el mes del corte; con todas, las migradas cuentan una vez', () => {
    const m = montosAdjudicados(ordenes, 'todas', 2026, asOf);
    expect(m.meses).toHaveLength(9);
    expect(m.meses[0].montos).toEqual({ MXN: 150.56 });
    expect(m.meses[1].montos).toEqual({ USD: 10 });
    expect(m.total).toEqual({ MXN: 150.56, USD: 10 });
    expect(m.monedas).toEqual(['MXN', 'USD']);
    expect(m.ordenes).toBe(3);
  });

  it('I3: la página de SAP no suma sus OC creadas desde Maximo (se cuentan en la de Maximo)', () => {
    const m = montosAdjudicados(ordenes, 'sap', 2026, asOf);
    expect(m.total).toEqual({ MXN: 50.56, USD: 10 });
    expect(m.ordenes).toBe(2);
    expect(m.migradas_excluidas).toBe(1);
    expect(montosAdjudicados(ordenes, 'maximo', 2026, asOf).total).toEqual({
      MXN: 100,
    });
    expect(
      montosAdjudicados(ordenes, 'todas', 2026, asOf).migradas_excluidas,
    ).toBe(0);
  });

  it('un año cerrado muestra sus 12 meses', () => {
    const m = montosAdjudicados(ordenes, 'maximo', 2025, asOf);
    expect(m.meses).toHaveLength(12);
    expect(m.total).toEqual({ MXN: 5 });
  });
});

describe('página de la semana', () => {
  const gestiones = [
    sap({ recibida: D('2026-09-22'), primera_oc: D('2026-09-24') }),
    sap({ recibida: D('2026-09-01'), cancelada: D('2026-09-10') }),
    maximo({ recibida: D('2026-09-02'), primera_oc: D('2026-09-12') }),
    maximo({ recibida: D('2026-09-03'), fecha_origen: 'alta' }),
    maximo({ recibida: D('2025-05-03'), primera_oc: D('2025-05-20') }),
    maximo({ recibida: D('2025-06-03') }),
  ];
  const now = T('2026-09-30T18:00:00Z');

  it('todas: suma SAP y Maximo con su desglose; cancelación solo SAP', () => {
    const page = buildAvancePage(
      data(gestiones),
      D('2026-09-23'),
      'todas',
      now,
    );
    expect(page.semana).toMatchObject({
      lunes: '2026-09-21',
      domingo: '2026-09-27',
      anio: 2026,
      etiqueta: 'Semana del 21 al 25 de septiembre de 2026',
      corte: '27 de septiembre de 2026',
    });
    expect(page.fuente.etiqueta).toBe('Maximo + SAP');
    expect(page.avance).toMatchObject({
      recibidas_anio: 4,
      nuevas_semana: 1,
      cerradas_anio: 2,
      cerradas_semana: 1,
      anio_anterior: null,
    });
    expect(page.por_sistema.sap?.recibidas_anio).toBe(2);
    expect(page.por_sistema.maximo?.recibidas_anio).toBe(2);
    expect(page.cancelacion).toMatchObject({
      disponible: true,
      nota: 'Solo SAP; Maximo no envía el estatus de las solicitudes.',
    });
    expect(page.cierre.semanas.map((s) => s.lunes)).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
    ]);
    expect(page.anual.map((c) => c.anio)).toEqual([
      2022, 2023, 2024, 2025, 2026,
    ]);
    expect(page.anual[3]).toMatchObject({
      recibidas: 2,
      cerradas: 1,
      sin_oc: 1,
    });
    expect(page.notas[0]).toContain('Maximo no envía el estatus');
  });

  it('solo Maximo: cancelación "No disponible" y sin canceladas en los datos', () => {
    const page = buildAvancePage(
      data(gestiones),
      D('2026-09-21'),
      'maximo',
      now,
    );
    expect(page.cancelacion).toMatchObject({
      disponible: false,
      anio: null,
      semanas: [],
      nota: 'No disponible: Maximo no envía el estatus de las solicitudes.',
    });
    expect(page.estado_anio).toMatchObject({
      recibidas: 2,
      cerradas: 1,
      sin_oc: 1,
    });
    expect(page.no_disponible.map((n) => n.dato)).toContain(
      'Tiempo promedio de cancelación',
    );
  });

  it('solo SAP: sin la nota de Maximo', () => {
    const page = buildAvancePage(data(gestiones), D('2026-09-21'), 'sap', now);
    expect(page.avance.recibidas_anio).toBe(2);
    expect(page.notas.join(' ')).not.toContain('CIISA');
    expect(page.no_disponible).toEqual([]);
  });

  it('I3: la página de SAP avisa cuántas OC migradas de Maximo no suma', () => {
    const conMigradas: AvanceData = {
      ...data(gestiones),
      ordenes: [
        {
          sistema: 'sap',
          fecha: D('2026-09-02'),
          moneda: 'MXN',
          monto: 10,
          contada_en_maximo: true,
        },
        {
          sistema: 'sap',
          fecha: D('2026-09-03'),
          moneda: 'MXN',
          monto: 20,
          contada_en_maximo: true,
        },
      ],
    };
    const sapPage = buildAvancePage(conMigradas, D('2026-09-21'), 'sap', now);
    expect(sapPage.montos.total).toEqual({});
    expect(sapPage.notas).toContain(
      '2 OC de SAP creadas desde Maximo en 2026 no se suman aquí: son de la gestión de Maximo y se cuentan en su página.',
    );
    const maximoPage = buildAvancePage(
      conMigradas,
      D('2026-09-21'),
      'maximo',
      now,
    );
    expect(maximoPage.notas.join(' ')).not.toContain('no se suman aquí');
  });

  it('en enero muestra lo que sigue sin atender del año anterior', () => {
    const page = buildAvancePage(
      data(gestiones),
      D('2026-01-05'),
      'todas',
      now,
    );
    expect(page.avance.anio_anterior).toEqual({
      anio: 2025,
      abiertas: 0,
      sin_oc: 1,
    });
  });

  it('la semana del 29-dic es del año de su lunes (como en el archivo de Jorge)', () => {
    const page = buildAvancePage(
      data(gestiones),
      D('2025-12-29'),
      'todas',
      now,
    );
    expect(page.semana.anio).toBe(2025);
    expect(page.avance.recibidas_anio).toBe(2);
    expect(page.montos.meses).toHaveLength(12);
  });
});

describe('I3: un reporte por sistema, homologados', () => {
  it('ambos = Maximo y luego SAP; las demás, una fuente', () => {
    expect(fuentesDelReporte('ambos')).toEqual(['maximo', 'sap']);
    expect(fuentesDelReporte('sap')).toEqual(['sap']);
    expect(fuentesDelReporte('todas')).toEqual(['todas']);
  });

  it('las definiciones de cada página hablan solo de su sistema', () => {
    const sinMontos = (fuente: 'maximo' | 'sap') =>
      Object.entries(avanceDefiniciones(fuente))
        .filter(([clave]) => clave !== 'montos')
        .map(([, texto]) => texto)
        .join(' ');
    expect(sinMontos('maximo')).not.toContain('SAP');
    expect(sinMontos('sap')).not.toContain('Maximo');
    expect(avanceDefiniciones('sap').montos).toContain(
      'se cuentan en la página de Maximo',
    );
    expect(avanceDefiniciones('todas').gestion).toContain('SAP y PR de Maximo');
  });
});
