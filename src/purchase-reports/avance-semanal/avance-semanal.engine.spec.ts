import { gestionDays } from '../../purchase-dashboard/sap-gestion-days';
import {
  anioDe,
  type AvanceData,
  avanceDefiniciones,
  buildAvancePage,
  cohortes,
  type CuentaDias,
  diasHabiles,
  diasHasta,
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
  ventanaSemana,
  weeksBetween,
} from './avance-semanal.engine';
import {
  AVANCE_OPCIONES,
  AVANCE_REGLAS,
  type AvanceOpciones,
} from './avance-semanal.reglas';

/**
 * H1 (2026-09-29) — motor del reporte de avance semanal con fixtures:
 * límites de semana, cohortes al corte, canceladas y montos por mes.
 * K5 (2026-10-05): Maximo con sus fechas reales (sin "sin OC" ni fechas
 * aproximadas), corte en hora de México, días desde el inicio de la regla y
 * montos en dos bases.
 */

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (iso: string) => new Date(iso);

const sap = (overrides: Partial<Gestion>): Gestion => {
  const recibida = overrides.recibida ?? D('2026-09-01');
  return {
    sistema: 'sap',
    folio: '1',
    recibida,
    fecha_origen: 'documento',
    inicio_dias: recibida,
    primera_oc: null,
    cierre_sin_oc: null,
    cancelada: null,
    de_contrato: false,
    ...overrides,
  };
};

const maximo = (overrides: Partial<Gestion>): Gestion =>
  sap({
    sistema: 'maximo',
    folio: 'PR1',
    fecha_origen: 'aprobacion',
    ...overrides,
  });

const data = (
  gestiones: Gestion[],
  ordenes: OrdenMonto[] = [],
): AvanceData => ({
  gestiones,
  ordenes,
  maximo_no_recibidas: [],
  sap_desde: D('2026-01-12'),
});

const opciones = (o: Partial<AvanceOpciones>): AvanceOpciones => ({
  ...AVANCE_OPCIONES,
  ...o,
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

  it('K5: corte en hora de México para Maximo y por día calendario para SAP', () => {
    // domingo 23:59 de México = lunes 06:00 UTC
    expect(ventanaSemana(D('2026-09-21'), 'maximo', 'domingo')).toEqual({
      inicio: T('2026-09-21T06:00:00Z').getTime(),
      fin: T('2026-09-28T06:00:00Z').getTime(),
    });
    expect(ventanaSemana(D('2026-09-21'), 'sap', 'domingo')).toEqual({
      inicio: D('2026-09-21').getTime(),
      fin: D('2026-09-28').getTime(),
    });
    // corte el viernes: de sábado a viernes
    expect(ventanaSemana(D('2026-09-21'), 'maximo', 'viernes')).toEqual({
      inicio: T('2026-09-19T06:00:00Z').getTime(),
      fin: T('2026-09-26T06:00:00Z').getTime(),
    });
    // el año de Maximo empieza el 1-ene a las 06:00 UTC
    expect(anioDe(T('2027-01-01T05:59:00Z'), 'maximo')).toBe(2026);
    expect(anioDe(T('2027-01-01T06:00:00Z'), 'maximo')).toBe(2027);
    expect(anioDe(D('2027-01-01'), 'sap')).toBe(2027);
  });
});

describe('estado de una gestión al corte', () => {
  const fin = T('2026-09-28T00:00:00Z').getTime();

  it('cerrada con su primera OC; si la OC es de otra semana posterior, sigue abierta', () => {
    expect(estadoAl(sap({ primera_oc: D('2026-09-10') }), fin)).toMatchObject({
      estado: 'cerrada',
      con_oc: true,
    });
    expect(estadoAl(sap({ primera_oc: D('2026-09-28') }), fin).estado).toBe(
      'abierta',
    );
  });

  it('OC capturada antes que la solicitud: cierra cuando se recibe', () => {
    const e = estadoAl(
      sap({ recibida: D('2026-09-10'), primera_oc: D('2026-09-01') }),
      fin,
    );
    expect(e.fecha).toBe(D('2026-09-10').getTime());
  });

  it('SAP: cancelada o cerrada a mano sin OC; K5: Maximo sin evento queda abierta', () => {
    expect(estadoAl(sap({ cancelada: D('2026-09-05') }), fin).estado).toBe(
      'cancelada',
    );
    expect(
      estadoAl(sap({ cierre_sin_oc: D('2026-09-05') }), fin),
    ).toMatchObject({ estado: 'cerrada', con_oc: false });
    expect(estadoAl(maximo({}), fin).estado).toBe('abierta');
    // cancelada con la fecha de su CAN
    expect(
      estadoAl(maximo({ cancelada: T('2026-09-20T17:00:00Z') }), fin),
    ).toMatchObject({
      estado: 'cancelada',
      fecha: T('2026-09-20T17:00:00Z').getTime(),
    });
  });

  it('K5: al corte gana cerrada sobre cancelada; un evento posterior al corte no cuenta', () => {
    const g = maximo({
      cierre_sin_oc: T('2026-09-10T17:00:00Z'),
      cancelada: T('2026-09-08T17:00:00Z'),
    });
    expect(estadoAl(g, fin).estado).toBe('cerrada');
    expect(estadoAl(g, T('2026-09-09T00:00:00Z').getTime()).estado).toBe(
      'cancelada',
    );
    expect(estadoAl(g, T('2026-09-08T00:00:00Z').getTime()).estado).toBe(
      'abierta',
    );
  });
});

describe('cohortes por año al corte', () => {
  const lunes = D('2026-09-21');
  const gestiones = [
    // 2026: 2 cerradas (5 y 11 días), 1 cancelada (4 días), 3 abiertas
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

  it('recibidas del año y, de esas, cerradas / canceladas / abiertas (K5: Maximo sin "sin OC")', () => {
    const [y2025, y2026] = cohortes(gestiones, [2025, 2026], lunes);
    expect(y2026).toMatchObject({
      recibidas: 6,
      cerradas: 2,
      canceladas: 1,
      abiertas: 3,
      atendidas: 3,
      atendidas_pct: 50,
    });
    expect(y2026).not.toHaveProperty('sin_oc');
    expect(y2026.dias_cierre).toEqual({
      promedio_dias: 8,
      mediana_dias: 8,
      total: 2,
    });
    expect(y2026.dias_cancelacion.promedio_dias).toBe(4);
    expect(y2025).toMatchObject({ recibidas: 1, cerradas: 1 });
  });

  it('la misma gestión, vista al corte de una semana anterior (viernes 4-sep), todavía no cerraba', () => {
    const [y2026] = cohortes(gestiones, [2026], D('2026-08-31'), 'viernes');
    expect(y2026).toMatchObject({
      recibidas: 5,
      cerradas: 0,
      canceladas: 0,
      abiertas: 5,
    });
  });

  it('K5: identidad recibidas = cerradas + canceladas + abiertas en cada año y cada corte', () => {
    for (const semana of ['2026-08-31', '2026-09-07', '2026-09-21']) {
      for (const c of cohortes(gestiones, [2025, 2026], D(semana))) {
        expect(c.cerradas + c.canceladas + c.abiertas).toBe(c.recibidas);
      }
    }
  });
});

describe('lo que pasó en la semana', () => {
  it('nuevas, cerradas de cualquier año y sus días', () => {
    const s = semanaStats(
      [
        sap({ recibida: D('2026-09-22'), primera_oc: D('2026-09-24') }),
        maximo({ recibida: D('2026-09-23') }),
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
      cerradas: 2,
      cerradas_anteriores: 1,
      canceladas: 1,
    });
    expect(s).not.toHaveProperty('nuevas_aproximadas');
    expect(s.dias_cierre.total).toBe(2);
    expect(s.dias_cancelacion.promedio_dias).toBe(25);
  });

  it('K5: una PR aprobada el domingo 23:30 de México cuenta en esa semana (no en la siguiente)', () => {
    const g = maximo({ recibida: T('2026-09-28T05:30:00Z') });
    expect(semanaStats([g], D('2026-09-21')).nuevas).toBe(1);
    expect(semanaStats([g], D('2026-09-28')).nuevas).toBe(0);
    const [y2026] = cohortes([g], [2026], D('2026-09-21'));
    expect(y2026.recibidas).toBe(1);
    // SAP por día calendario: el lunes 28 ya es de la semana siguiente
    const s = sap({ recibida: D('2026-09-28') });
    expect(semanaStats([s], D('2026-09-21')).nuevas).toBe(0);
    // con corte el viernes, el sábado 06:00 de México ya es de la siguiente
    const sabado = maximo({ recibida: T('2026-09-26T12:00:00Z') });
    expect(semanaStats([sabado], D('2026-09-21'), 'viernes').nuevas).toBe(0);
    expect(semanaStats([sabado], D('2026-09-28'), 'viernes').nuevas).toBe(1);
  });

  it('K5: cerrada por CLOSE sin OC cuenta en su semana, sin días; H1 cuenta las que no son de contrato', () => {
    const close = maximo({
      recibida: T('2026-09-15T15:00:00Z'),
      cierre_sin_oc: T('2026-09-23T17:00:00Z'),
    });
    const deContrato = maximo({
      recibida: T('2026-09-15T15:00:00Z'),
      cierre_sin_oc: T('2026-09-23T17:00:00Z'),
      de_contrato: true,
    });
    const s = semanaStats([close, deContrato], D('2026-09-21'));
    expect(s.cerradas).toBe(2);
    expect(s.dias_cierre.total).toBe(0);
    const [y2026] = cohortes([close, deContrato], [2026], D('2026-09-21'));
    expect(y2026).toMatchObject({
      cerradas: 2,
      cerradas_sin_oc: 2,
      cerradas_sin_oc_ni_contrato: 1,
    });
    expect(y2026.dias_cierre.total).toBe(0);
  });

  it('K5: OC anterior a la aprobación = cerrada en R y fuera de los días', () => {
    const g = maximo({
      recibida: T('2026-09-22T16:00:00Z'),
      primera_oc: T('2026-09-18T10:00:00Z'),
    });
    expect(semanaStats([g], D('2026-09-14')).cerradas).toBe(0);
    const s = semanaStats([g], D('2026-09-21'));
    expect(s.cerradas).toBe(1);
    expect(s.dias_cierre.total).toBe(0);
    expect(cohortes([g], [2026], D('2026-09-21'))[0].dias_cierre.total).toBe(0);
  });

  it('K5: cancelada con la fecha de su CAN; los días cuentan desde el inicio de la regla', () => {
    const desdeAprobacion = maximo({
      recibida: T('2026-09-10T15:00:00Z'),
      cancelada: T('2026-09-24T15:00:00Z'),
    });
    const desdeEmision = maximo({
      recibida: T('2026-09-10T15:00:00Z'),
      inicio_dias: T('2026-09-08T15:00:00Z'),
      cancelada: T('2026-09-24T15:00:00Z'),
    });
    const s = semanaStats([desdeAprobacion], D('2026-09-21'));
    expect(s.canceladas).toBe(1);
    expect(s.dias_cancelacion.promedio_dias).toBe(14);
    expect(
      semanaStats([desdeEmision], D('2026-09-21')).dias_cancelacion
        .promedio_dias,
    ).toBe(16);
    // sin inicio (PR sin APPR con dias_desde='aprobacion'): sin días
    const sinInicio = maximo({
      recibida: T('2026-09-10T15:00:00Z'),
      inicio_dias: null,
      cancelada: T('2026-09-24T15:00:00Z'),
    });
    const sin = semanaStats([sinInicio], D('2026-09-21'));
    expect(sin.canceladas).toBe(1);
    expect(sin.dias_cancelacion.total).toBe(0);
  });
});

describe('H3: días hábiles (lunes a viernes sin festivos, con fracción)', () => {
  // semana del 21-sep-2026: lunes 21 … viernes 25, sábado 26, domingo 27
  const H = 1 / 24;
  const habiles: CuentaDias = { tipo: 'habiles', festivos: [] };

  it('viernes 17:00 a lunes 09:00 hora local = 7 h + 9 h (Maximo en hora de México, SAP sin desfase)', () => {
    // Maximo: 17:00 de México = 23:00 UTC; 09:00 = 15:00 UTC
    const desde = T('2026-09-25T23:00:00Z');
    const hasta = T('2026-09-28T15:00:00Z');
    expect(diasHabiles(desde, hasta, 'maximo')).toBeCloseTo(7 * H + 9 * H, 10);
    // los naturales son 2 días y 16 h
    expect(gestionDays(desde, hasta)).toBeCloseTo(2 + 16 * H, 10);
    // SAP: día calendario (UTC)
    expect(
      diasHabiles(T('2026-09-25T17:00:00Z'), T('2026-09-28T09:00:00Z'), 'sap'),
    ).toBeCloseTo(7 * H + 9 * H, 10);
  });

  it('el desfase cuenta: el viernes 21:00 de México ya es sábado en UTC', () => {
    const desde = T('2026-09-26T03:00:00Z'); // viernes 21:00 de México
    const hasta = T('2026-09-28T15:00:00Z'); // lunes 09:00 de México
    expect(diasHabiles(desde, hasta, 'maximo')).toBeCloseTo(3 * H + 9 * H, 10);
    // como SAP (sin desfase) el inicio es sábado: solo el lunes hasta las 15:00
    expect(diasHabiles(desde, hasta, 'sap')).toBeCloseTo(15 * H, 10);
  });

  it('de un lunes 00:00 al siguiente = 5; un festivo entre semana resta 1 (en sábado, nada)', () => {
    expect(
      diasHabiles(
        T('2026-09-21T06:00:00Z'),
        T('2026-09-28T06:00:00Z'),
        'maximo',
      ),
    ).toBe(5);
    expect(diasHabiles(D('2026-09-21'), D('2026-09-28'), 'sap')).toBe(5);
    // 16-sep-2026 es miércoles
    expect(
      diasHabiles(D('2026-09-14'), D('2026-09-21'), 'sap', ['2026-09-16']),
    ).toBe(4);
    expect(
      diasHabiles(
        T('2026-09-14T06:00:00Z'),
        T('2026-09-21T06:00:00Z'),
        'maximo',
        ['2026-09-16'],
      ),
    ).toBe(4);
    // festivo en sábado o fuera del intervalo: no resta
    expect(
      diasHabiles(D('2026-09-14'), D('2026-09-21'), 'sap', [
        '2026-09-19',
        '2026-12-25',
      ]),
    ).toBe(5);
  });

  it('el festivo de Maximo es el día de México (de 06:00 a 06:00 UTC)', () => {
    // martes 15 18:00 a jueves 17 06:00 de México, con el miércoles festivo
    const desde = T('2026-09-16T00:00:00Z');
    const hasta = T('2026-09-17T12:00:00Z');
    expect(diasHabiles(desde, hasta, 'maximo', ['2026-09-16'])).toBeCloseTo(
      6 * H + 6 * H,
      10,
    );
    expect(diasHabiles(desde, hasta, 'maximo')).toBeCloseTo(36 * H, 10);
  });

  it('mismo instante = 0; evento anterior al inicio = null (como gestionDays)', () => {
    const t = T('2026-09-23T15:30:00Z');
    expect(diasHabiles(t, t, 'maximo')).toBe(0);
    expect(diasHabiles(D('2026-09-26'), D('2026-09-26'), 'sap')).toBe(0);
    expect(
      diasHabiles(
        T('2026-09-23T15:30:00Z'),
        T('2026-09-22T15:30:00Z'),
        'maximo',
      ),
    ).toBeNull();
    expect(
      gestionDays(T('2026-09-23T15:30:00Z'), T('2026-09-22T15:30:00Z')),
    ).toBeNull();
  });

  it('diasHasta: naturales (default) con gestionDays y hábiles con diasHabiles; sin inicio o evento anterior → null', () => {
    const g = maximo({
      recibida: T('2026-09-25T23:00:00Z'),
      inicio_dias: T('2026-09-25T23:00:00Z'),
    });
    const lunes = T('2026-09-28T15:00:00Z');
    expect(diasHasta(g, lunes)).toBeCloseTo(2 + 16 * H, 10);
    expect(diasHasta(g, lunes, habiles)).toBeCloseTo(16 * H, 10);
    expect(diasHasta(g, null, habiles)).toBeNull();
    expect(diasHasta({ ...g, inicio_dias: null }, lunes, habiles)).toBeNull();
    expect(diasHasta(g, T('2026-09-24T12:00:00Z'), habiles)).toBeNull();
  });

  it('cohortes y semana con hábiles: días menores que los naturales; los festivos restan; los conteos no cambian', () => {
    const gestiones = [
      // lunes a lunes: 7 naturales, 5 hábiles (4 con el 16-sep)
      sap({ recibida: D('2026-09-14'), primera_oc: D('2026-09-21') }),
      maximo({
        recibida: T('2026-09-14T06:00:00Z'),
        inicio_dias: T('2026-09-14T06:00:00Z'),
        primera_oc: T('2026-09-21T06:00:00Z'),
      }),
      // viernes a lunes: 3 naturales, 1 hábil
      sap({ recibida: D('2026-09-11'), cancelada: D('2026-09-14') }),
    ];
    const lunes = D('2026-09-21');
    const [naturales] = cohortes(gestiones, [2026], lunes);
    const [enHabiles] = cohortes(gestiones, [2026], lunes, 'domingo', habiles);
    const [conFestivo] = cohortes(gestiones, [2026], lunes, 'domingo', {
      tipo: 'habiles',
      festivos: ['2026-09-16'],
    });
    expect(naturales.dias_cierre.promedio_dias).toBe(7);
    expect(naturales.dias_cancelacion.promedio_dias).toBe(3);
    expect(enHabiles.dias_cierre.promedio_dias).toBe(5);
    expect(enHabiles.dias_cancelacion.promedio_dias).toBe(1);
    expect(conFestivo.dias_cierre).toEqual({
      promedio_dias: 4,
      mediana_dias: 4,
      total: 2,
    });
    // la cuenta de días no mueve los estados
    for (const c of [enHabiles, conFestivo]) {
      expect(c).toMatchObject({
        recibidas: naturales.recibidas,
        cerradas: naturales.cerradas,
        canceladas: naturales.canceladas,
        abiertas: naturales.abiertas,
      });
    }
    // cerradas en la semana del 21-sep, con sus días hábiles
    const s = semanaStats(gestiones, lunes, 'domingo', habiles);
    expect(s.cerradas).toBe(2);
    expect(s.dias_cierre.promedio_dias).toBe(5);
    expect(semanaStats(gestiones, lunes).dias_cierre.promedio_dias).toBe(7);
  });

  it('la página (Maximo y SAP) cuenta en hábiles con los festivos de los datos y lo dice; el default sigue en naturales', () => {
    const gestiones = [
      sap({ recibida: D('2026-09-14'), primera_oc: D('2026-09-21') }),
      maximo({
        recibida: T('2026-09-14T06:00:00Z'),
        primera_oc: T('2026-09-21T06:00:00Z'),
      }),
      maximo({
        recibida: T('2026-09-11T06:00:00Z'),
        cancelada: T('2026-09-14T06:00:00Z'),
      }),
    ];
    const conFestivos: AvanceData = {
      ...data(gestiones),
      festivos: ['2026-09-16'],
    };
    const now = T('2026-09-30T18:00:00Z');
    const enHabiles = opciones({
      reglas: { ...AVANCE_REGLAS, dias_tipo: 'habiles' },
    });
    const maximoPag = buildAvancePage(
      conFestivos,
      D('2026-09-21'),
      'maximo',
      now,
      enHabiles,
    );
    const sapPag = buildAvancePage(
      conFestivos,
      D('2026-09-21'),
      'sap',
      now,
      enHabiles,
    );
    expect(maximoPag.opciones.reglas.dias_tipo).toBe('habiles');
    expect(maximoPag.cierre).toMatchObject({ unidad: 'días hábiles' });
    expect(maximoPag.cancelacion).toMatchObject({ unidad: 'días hábiles' });
    // lunes a lunes con el miércoles 16 festivo: 4; viernes a lunes: 1
    expect(maximoPag.cierre.anio.promedio_dias).toBe(4);
    expect(maximoPag.cancelacion.anio?.promedio_dias).toBe(1);
    expect(sapPag.cierre.anio.promedio_dias).toBe(4);
    expect(sapPag.cierre.unidad).toBe('días hábiles');
    expect(maximoPag.notas.join(' ')).toContain(
      'en días hábiles: de lunes a viernes, sin los días festivos registrados',
    );
    // sin festivos en los datos: solo se quitan sábados y domingos
    const sinFestivos = buildAvancePage(
      data(gestiones),
      D('2026-09-21'),
      'maximo',
      now,
      enHabiles,
    );
    expect(sinFestivos.cierre.anio.promedio_dias).toBe(5);
    expect(sinFestivos.notas.join(' ')).toContain(
      'no hay días festivos registrados',
    );
    // default (AVANCE_REGLAS): naturales, aunque haya festivos
    expect(AVANCE_REGLAS.dias_tipo).toBe('naturales');
    const naturales = buildAvancePage(
      conFestivos,
      D('2026-09-21'),
      'maximo',
      now,
    );
    expect(naturales.cierre).toMatchObject({ unidad: 'días' });
    expect(naturales.cancelacion.unidad).toBe('días');
    expect(naturales.cierre.anio.promedio_dias).toBe(7);
    expect(naturales.notas.join(' ')).not.toContain('hábiles');
  });
});

describe('H2: cerradas de contrato al corte', () => {
  it('cuenta la PR de contrato cerrada (con OC o por CLOSE); no la sin contrato, ni la de contrato abierta o cancelada; en SAP, 0', () => {
    const recibida = T('2026-09-01T15:00:00Z');
    const gestiones = [
      // de contrato, cerrada con OC: cuenta
      maximo({
        recibida,
        primera_oc: T('2026-09-10T15:00:00Z'),
        de_contrato: true,
      }),
      // de contrato, cerrada por CLOSE sin OC: cuenta (y no es H1)
      maximo({
        recibida,
        cierre_sin_oc: T('2026-09-11T15:00:00Z'),
        de_contrato: true,
      }),
      // sin contrato, cerrada: no cuenta
      maximo({ recibida, primera_oc: T('2026-09-10T15:00:00Z') }),
      // de contrato, abierta: no cuenta
      maximo({ recibida, de_contrato: true }),
      // de contrato, cancelada: no cuenta
      maximo({
        recibida,
        cancelada: T('2026-09-12T15:00:00Z'),
        de_contrato: true,
      }),
      // de contrato, cerrada después del corte: al corte sigue abierta
      maximo({
        recibida,
        primera_oc: T('2026-10-01T15:00:00Z'),
        de_contrato: true,
      }),
      // SAP no tiene contrato (aunque la marca viniera en true)
      sap({
        recibida: D('2026-09-01'),
        primera_oc: D('2026-09-10'),
        de_contrato: true,
      }),
    ];
    const [y2026] = cohortes(gestiones, [2026], D('2026-09-14'));
    expect(y2026).toMatchObject({
      recibidas: 7,
      cerradas: 4,
      cerradas_de_contrato: 2,
      cerradas_sin_oc: 1,
      cerradas_sin_oc_ni_contrato: 0,
      canceladas: 1,
      abiertas: 2,
    });
    // al corte del domingo 6-sep ya estaban recibidas y ninguna cerraba
    const [antes] = cohortes(gestiones, [2026], D('2026-08-31'));
    expect(antes).toMatchObject({ recibidas: 7, cerradas_de_contrato: 0 });
    const now = T('2026-09-30T18:00:00Z');
    const pagina = (fuente: 'maximo' | 'sap') =>
      buildAvancePage(data(gestiones), D('2026-09-14'), fuente, now);
    expect(pagina('maximo').estado_anio.cerradas_de_contrato).toBe(2);
    expect(pagina('sap').estado_anio.cerradas_de_contrato).toBe(0);
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
    subtotal: monto,
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
  const lunes = D('2026-09-21');

  it('por mes y moneda, hasta el mes del corte; con todas, las migradas cuentan una vez', () => {
    const m = montosAdjudicados(ordenes, 'todas', 2026, lunes);
    expect(m.meses).toHaveLength(9);
    expect(m.meses[0].montos).toEqual({ MXN: 150.56 });
    expect(m.meses[1].montos).toEqual({ USD: 10 });
    expect(m.total).toEqual({ MXN: 150.56, USD: 10 });
    expect(m.monedas).toEqual(['MXN', 'USD']);
    expect(m.ordenes).toBe(3);
  });

  it('I3: la página de SAP no suma sus OC creadas desde Maximo (se cuentan en la de Maximo)', () => {
    const m = montosAdjudicados(ordenes, 'sap', 2026, lunes);
    expect(m.total).toEqual({ MXN: 50.56, USD: 10 });
    expect(m.ordenes).toBe(2);
    expect(m.migradas_excluidas).toBe(1);
    expect(montosAdjudicados(ordenes, 'maximo', 2026, lunes).total).toEqual({
      MXN: 100,
    });
    expect(
      montosAdjudicados(ordenes, 'todas', 2026, lunes).migradas_excluidas,
    ).toBe(0);
  });

  it('un año cerrado muestra sus 12 meses', () => {
    const m = montosAdjudicados(ordenes, 'maximo', 2025, lunes);
    expect(m.meses).toHaveLength(12);
    expect(m.total).toEqual({ MXN: 5 });
  });

  describe('K5: dos bases y fuente de los montos de Maximo', () => {
    const k5 = [
      o('maximo', '2026-03-10', 116, { subtotal: 100 }),
      // sin subtotal: no se estima
      o('maximo', '2026-03-11', 58, { subtotal: null }),
      // migrada a SAP (cuenta en Maximo)
      o('sap', '2026-03-12', 232, { subtotal: 200, contada_en_maximo: true }),
      o('sap', '2026-03-13', 11.6, { subtotal: 10, moneda: 'USD' }),
      // 31-ene 21:00 de México: es de enero
      {
        ...o('maximo', '2026-02-01', 11.6, { subtotal: 10 }),
        fecha: T('2026-02-01T03:00:00Z'),
      },
    ];

    it('sin IVA (default): suma el subtotal, da el con IVA aparte y cuenta las OC sin subtotal', () => {
      expect(AVANCE_OPCIONES.monto_base).toBe('sin_iva');
      const m = montosAdjudicados(k5, 'maximo', 2026, lunes);
      expect(m.base).toBe('sin_iva');
      expect(m.total).toEqual({ MXN: 110 });
      expect(m.meses[0].montos).toEqual({ MXN: 10 });
      expect(m.meses[2].montos).toEqual({ MXN: 100 });
      expect(m.ordenes).toBe(2);
      expect(m.otro).toEqual({ base: 'con_iva', total: { MXN: 185.6 } });
      expect(m.sin_subtotal).toEqual({ ordenes: 1, con_iva: { MXN: 58 } });
      expect(m.fuente_maximo).toBe('maximo');
    });

    it('con IVA: suma el total y el sin IVA (de las que lo traen) va aparte', () => {
      const m = montosAdjudicados(
        k5,
        'maximo',
        2026,
        lunes,
        opciones({ monto_base: 'con_iva' }),
      );
      expect(m.total).toEqual({ MXN: 185.6 });
      expect(m.ordenes).toBe(3);
      expect(m.otro).toEqual({ base: 'sin_iva', total: { MXN: 110 } });
      expect(m.sin_subtotal.ordenes).toBe(1);
    });

    it("con 'sap_migradas', Maximo toma las OC de SAP migradas; SAP no cambia", () => {
      const conMigradas = opciones({ montos_fuente_maximo: 'sap_migradas' });
      const m = montosAdjudicados(k5, 'maximo', 2026, lunes, conMigradas);
      expect(m.total).toEqual({ MXN: 200 });
      expect(m.otro.total).toEqual({ MXN: 232 });
      expect(m.sin_subtotal.ordenes).toBe(0);
      expect(m.fuente_maximo).toBe('sap_migradas');
      const s = montosAdjudicados(k5, 'sap', 2026, lunes, conMigradas);
      expect(s.total).toEqual({ USD: 10 });
      expect(s.migradas_excluidas).toBe(1);
      expect(s.fuente_maximo).toBeNull();
      expect(
        montosAdjudicados(k5, 'todas', 2026, lunes, conMigradas).total,
      ).toEqual({ MXN: 200, USD: 10 });
    });

    it('H9: cada mes cuenta sus OC sin subtotal por moneda (mes sin compras ≠ mes sin subtotal)', () => {
      const conAbril = [
        ...k5,
        // abril: solo una OC en USD sin subtotal
        o('maximo', '2026-04-10', 58, { subtotal: null, moneda: 'USD' }),
      ];
      const m = montosAdjudicados(conAbril, 'maximo', 2026, lunes);
      expect(m.meses[0].sin_subtotal).toEqual({});
      // febrero: sin OC
      expect(m.meses[1]).toMatchObject({ montos: {}, sin_subtotal: {} });
      // marzo: una con subtotal y otra sin él
      expect(m.meses[2]).toMatchObject({
        montos: { MXN: 100 },
        sin_subtotal: { MXN: 1 },
      });
      // abril: con compras, pero ninguna con el monto sin IVA
      expect(m.meses[3]).toMatchObject({
        montos: {},
        ordenes: 0,
        sin_subtotal: { USD: 1 },
      });
      expect(m.sin_subtotal.ordenes).toBe(2);
    });

    it("con 'sap_migradas', las copias de la misma PO en SAP se suman una vez (D1); 'sap' y 'todas' no cambian", () => {
      const conMigradas = opciones({ montos_fuente_maximo: 'sap_migradas' });
      // PO103374: la integración creó varias OC con el mismo NumAtCard,
      // total y fecha; vale la de menor DocNum (copia_migrada = false)
      const copias = [
        ...k5,
        o('sap', '2026-03-12', 232, {
          subtotal: 200,
          contada_en_maximo: true,
          copia_migrada: true,
        }),
        o('sap', '2026-03-12', 232, {
          subtotal: 200,
          contada_en_maximo: true,
          copia_migrada: true,
        }),
      ];
      const m = montosAdjudicados(copias, 'maximo', 2026, lunes, conMigradas);
      expect(m.total).toEqual({ MXN: 200 });
      expect(m.otro.total).toEqual({ MXN: 232 });
      expect(m.ordenes).toBe(1);
      const t = montosAdjudicados(copias, 'todas', 2026, lunes, conMigradas);
      expect(t.total).toEqual({ MXN: 200, USD: 10 });
      // la página de SAP sigue sin sumarlas (son de Maximo)
      const s = montosAdjudicados(copias, 'sap', 2026, lunes, conMigradas);
      expect(s.total).toEqual({ USD: 10 });
      // con la fuente por defecto ('maximo') las copias no entran nunca
      expect(montosAdjudicados(copias, 'maximo', 2026, lunes).total).toEqual(
        montosAdjudicados(k5, 'maximo', 2026, lunes).total,
      );
    });

    it('la página dice la base y las OC sin subtotal', () => {
      const page = buildAvancePage(
        data([], k5),
        lunes,
        'maximo',
        T('2026-09-30T18:00:00Z'),
      );
      expect(page.notas.join(' ')).toContain(
        'Montos sin IVA (suma de las líneas de la OC)',
      );
      expect(page.notas.join(' ')).toContain('1 OC sin subtotal');
      const conIva = buildAvancePage(
        data([], k5),
        lunes,
        'maximo',
        T('2026-09-30T18:00:00Z'),
        opciones({ monto_base: 'con_iva' }),
      );
      expect(conIva.notas.join(' ')).toContain('Montos con IVA');
    });
  });
});

describe('página de la semana', () => {
  const gestiones = [
    sap({ recibida: D('2026-09-22'), primera_oc: D('2026-09-24') }),
    sap({ recibida: D('2026-09-01'), cancelada: D('2026-09-10') }),
    maximo({ recibida: D('2026-09-02'), primera_oc: D('2026-09-12') }),
    maximo({ recibida: D('2026-09-03') }),
    maximo({ recibida: D('2025-05-03'), primera_oc: D('2025-05-20') }),
    maximo({ recibida: D('2025-06-03') }),
  ];
  const now = T('2026-09-30T18:00:00Z');

  it('todas: suma SAP y Maximo con su desglose; K5: cancelación de las dos fuentes', () => {
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
      corte_dia: 'domingo',
    });
    expect(page.fuente.etiqueta).toBe('Maximo + SAP');
    expect(page.opciones).toEqual(AVANCE_OPCIONES);
    expect(page.avance).toMatchObject({
      recibidas_anio: 4,
      nuevas_semana: 1,
      cerradas_anio: 2,
      cerradas_semana: 1,
      anio_anterior: null,
    });
    expect(page.avance).not.toHaveProperty('nuevas_aproximadas');
    expect(page.por_sistema.sap?.recibidas_anio).toBe(2);
    expect(page.por_sistema.maximo?.recibidas_anio).toBe(2);
    expect(page.cancelacion).toMatchObject({
      disponible: true,
      nota: 'De la solicitud (SAP) o la aprobación de la PR (Maximo) a su cancelación',
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
      abiertas: 1,
    });
    expect(page.notas.join(' ')).not.toContain('Maximo no envía');
    expect(page.notas.join(' ')).not.toContain('aproximad');
  });

  it('K5: solo Maximo: cancelación con dato, mismo formato que SAP y sin "No disponible"', () => {
    const page = buildAvancePage(
      data([
        ...gestiones,
        maximo({
          recibida: T('2026-09-04T15:00:00Z'),
          cancelada: T('2026-09-14T15:00:00Z'),
        }),
      ]),
      D('2026-09-21'),
      'maximo',
      now,
    );
    expect(page.cancelacion).toMatchObject({
      disponible: true,
      nota: 'De la aprobación de la PR a su cancelación',
    });
    expect(page.cancelacion.anio).toMatchObject({
      promedio_dias: 10,
      total: 1,
    });
    expect(page.cancelacion.semanas).toHaveLength(4);
    expect(page.cierre.nota).toBe('De la aprobación de la PR a su primera OC');
    expect(page.estado_anio).toMatchObject({
      recibidas: 3,
      cerradas: 1,
      canceladas: 1,
      abiertas: 1,
    });
    expect(page.no_disponible).toEqual([]);
  });

  it('K5: las PR emitidas en el año sin aprobar se cuentan aparte', () => {
    const conFuera: AvanceData = {
      ...data(gestiones),
      maximo_no_recibidas: [
        {
          prnum: 'PR9',
          emision: T('2026-09-10T15:00:00Z'),
          pr_status: 'WAPPR',
        },
        {
          prnum: 'PR8',
          emision: T('2026-09-29T15:00:00Z'),
          pr_status: 'WAPPR',
        }, // después del corte
        { prnum: 'PR7', emision: T('2025-09-10T15:00:00Z'), pr_status: 'CAN' }, // otro año
        { prnum: 'PR6', emision: null, pr_status: null },
      ],
    };
    const page = buildAvancePage(conFuera, D('2026-09-21'), 'maximo', now);
    expect(page.avance.maximo_no_recibidas).toBe(1);
    expect(page.notas[0]).toBe(
      '1 PR de Maximo emitida en 2026 no se ha aprobado (en aprobación o cancelada sin aprobar): no llegó a Compras y no cuenta como recibida.',
    );
    expect(
      buildAvancePage(conFuera, D('2026-09-21'), 'sap', now).avance
        .maximo_no_recibidas,
    ).toBeNull();
  });

  it('H6: la PR emitida antes del corte y aprobada después cuenta como no recibida en esa semana (con el estado al corte, no el de hoy)', () => {
    // emitida el 1-sep y aprobada el 15-sep (hoy ya tiene APPR)
    const pr = maximo({
      folio: 'PR77',
      recibida: T('2026-09-15T09:00:00Z'),
      inicio_dias: T('2026-09-15T09:00:00Z'),
      emision: T('2026-09-01T15:00:00Z'),
    });
    const conPr = data([pr]);
    // semana del 31-ago (corte dom 6-sep 23:59 MX): emitida, sin aprobar
    const antes = buildAvancePage(conPr, D('2026-08-31'), 'maximo', now);
    expect(antes.avance.maximo_no_recibidas).toBe(1);
    expect(antes.avance.recibidas_anio).toBe(0);
    expect(antes.notas[0]).toBe(
      '1 PR de Maximo emitida en 2026 no se ha aprobado (en aprobación o cancelada sin aprobar): no llegó a Compras y no cuenta como recibida.',
    );
    // semana del 14-sep: ya es recibida y no va aparte
    const despues = buildAvancePage(conPr, D('2026-09-14'), 'maximo', now);
    expect(despues.avance.maximo_no_recibidas).toBe(0);
    expect(despues.avance.recibidas_anio).toBe(1);
    expect(despues.avance.nuevas_semana).toBe(1);
    // antes de su emisión no cuenta en ningún lado
    expect(
      buildAvancePage(conPr, D('2026-08-24'), 'maximo', now).avance
        .maximo_no_recibidas,
    ).toBe(0);
  });

  it('H6: emitida el domingo 23:30 de México y aprobada el lunes → no recibida en esa semana (corte en hora de México)', () => {
    const pr = maximo({
      folio: 'PR78',
      // lunes 7-sep 05:30 UTC = domingo 6-sep 23:30 en México (UTC−6)
      emision: T('2026-09-07T05:30:00Z'),
      recibida: T('2026-09-07T15:00:00Z'),
      inicio_dias: T('2026-09-07T15:00:00Z'),
    });
    const page = buildAvancePage(data([pr]), D('2026-08-31'), 'maximo', now);
    expect(page.avance.maximo_no_recibidas).toBe(1);
    expect(page.avance.recibidas_anio).toBe(0);
    // con la regla 'emision' la recibida ES la emisión: nunca va aparte
    const porEmision = maximo({
      folio: 'PR79',
      fecha_origen: 'emision',
      recibida: T('2026-09-01T15:00:00Z'),
      emision: T('2026-09-01T15:00:00Z'),
    });
    expect(
      buildAvancePage(
        data([porEmision]),
        D('2026-08-31'),
        'maximo',
        now,
        opciones({ reglas: { ...AVANCE_REGLAS, recibida: 'emision' } }),
      ).avance.maximo_no_recibidas,
    ).toBe(0);
  });

  it('solo SAP: sin notas de Maximo', () => {
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
          subtotal: 8.62,
          contada_en_maximo: true,
        },
        {
          sistema: 'sap',
          fecha: D('2026-09-03'),
          moneda: 'MXN',
          monto: 20,
          subtotal: 17.24,
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
    expect(page.avance.anio_anterior).toEqual({ anio: 2025, abiertas: 1 });
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

  it('K5: con corte el viernes, la página dice el viernes', () => {
    const page = buildAvancePage(
      data(gestiones),
      D('2026-09-21'),
      'maximo',
      now,
      opciones({ reglas: { ...AVANCE_REGLAS, corte: 'viernes' } }),
    );
    expect(page.semana).toMatchObject({
      corte: '25 de septiembre de 2026',
      corte_dia: 'viernes',
    });
  });
});

describe('I3: un reporte por sistema, homologados', () => {
  it('ambos = Maximo y luego SAP; las demás, una fuente', () => {
    expect(fuentesDelReporte('ambos')).toEqual(['maximo', 'sap']);
    expect(fuentesDelReporte('sap')).toEqual(['sap']);
    expect(fuentesDelReporte('todas')).toEqual(['todas']);
  });

  it('las definiciones de cada página hablan solo de su sistema (K5: la diferencia va en `homologacion`)', () => {
    const propias = (fuente: 'maximo' | 'sap') =>
      Object.entries(avanceDefiniciones(fuente))
        .filter(([clave]) => clave !== 'montos' && clave !== 'homologacion')
        .map(([, texto]) => texto)
        .join(' ');
    expect(propias('maximo')).not.toContain('SAP');
    expect(propias('sap')).not.toContain('Maximo');
    expect(avanceDefiniciones('sap').montos).toContain(
      'se cuentan en la página de Maximo',
    );
    expect(avanceDefiniciones('todas').gestion).toContain('SAP y PR de Maximo');
    expect(avanceDefiniciones('maximo').homologacion).toContain('SAP');
    expect(avanceDefiniciones('sap').homologacion).toContain('Maximo');
  });

  it('K5: las definiciones siguen las reglas (recibida, días, base y corte)', () => {
    const def = avanceDefiniciones('maximo');
    expect(def.recibida).toContain('primera aprobación de la PR (APPR)');
    expect(def.dias).toContain('de la aprobación de la PR');
    expect(def.montos).toContain('sin IVA');
    expect(def.semana).toContain('hora de México');
    const variante = avanceDefiniciones(
      'maximo',
      opciones({
        reglas: {
          ...AVANCE_REGLAS,
          recibida: 'emision',
          dias_desde: 'emision',
          corte: 'viernes',
        },
        monto_base: 'con_iva',
        montos_fuente_maximo: 'sap_migradas',
      }),
    );
    expect(variante.recibida).toContain('emisión de la PR (ISSUEDATE)');
    expect(variante.dias).toContain('de la emisión de la PR');
    expect(variante.montos).toContain('OC de SAP creadas desde Maximo');
    expect(variante.montos).toContain('con IVA');
    expect(variante.semana).toContain('de sábado a viernes');
  });

  it('H3: con hábiles, las dos páginas lo explican (lunes a viernes, sin festivos de holidays) y lo dicen homologado', () => {
    const habiles = opciones({
      reglas: { ...AVANCE_REGLAS, dias_tipo: 'habiles' },
    });
    const maximoDef = avanceDefiniciones('maximo', habiles);
    const sapDef = avanceDefiniciones('sap', habiles);
    for (const def of [maximoDef, sapDef]) {
      expect(def.dias).toMatch(/^Días hábiles de cierre y de cancelación/);
      expect(def.dias).toContain('de lunes a viernes');
      expect(def.dias).toContain('holidays');
      expect(def.dias).not.toContain('la misma cuenta que los días de gestión');
      expect(def.homologacion).toContain(
        'se cuentan igual en las dos páginas: hábiles',
      );
    }
    expect(maximoDef.dias).toContain('en hora de México');
    expect(sapDef.dias).toContain('por día calendario');
    // cada página sigue hablando solo de su sistema
    const propias = (def: Record<string, string>) =>
      Object.entries(def)
        .filter(([clave]) => clave !== 'montos' && clave !== 'homologacion')
        .map(([, texto]) => texto)
        .join(' ');
    expect(propias(maximoDef)).not.toContain('SAP');
    expect(propias(sapDef)).not.toContain('Maximo');
    expect(avanceDefiniciones('todas', habiles).homologacion).toContain(
      'en las dos fuentes: hábiles',
    );
    // default: naturales, la misma cuenta que el tablero
    const def = avanceDefiniciones('maximo');
    expect(def.dias).toMatch(/^Días de cierre y de cancelación/);
    expect(def.dias).toContain('la misma cuenta que los días de gestión');
    expect(def.homologacion).toContain(
      'se cuentan igual en las dos páginas: naturales',
    );
  });
});
