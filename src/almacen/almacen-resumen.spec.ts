import {
  mesesEntre,
  nivelesClasificacion,
  resumir,
  SIN_CLASIFICACION,
  SIN_COSTO,
  tramoAntiguedad,
  TRAMOS_ANTIGUEDAD,
  type FilaExistencia,
} from './almacen-resumen';

const CORTE = '2026-11-09T08:00:00';

const fila = (o: Partial<FilaExistencia> = {}): FilaExistencia => ({
  parte: '2004375',
  descripcion: 'INTERRUPTOR',
  clasificacion: 'PARTES \\ ELE \\ INTERR',
  moneda: 'USD',
  cantidad: 4,
  unidad: 'UN',
  fechaEntrada: '2026-10-30T11:13:38',
  importePesos: 10868.85,
  importePesosOc: 10546,
  origen: 'Recepción',
  ...o,
});

describe('Almacén — resumen del corte', () => {
  it('parte la clasificación por niveles', () => {
    expect(nivelesClasificacion('PARTES \\ MEC \\ BOYA')).toEqual([
      'PARTES',
      'MEC',
      'BOYA',
    ]);
    expect(nivelesClasificacion('MATSTD')).toEqual(['MATSTD']);
    expect(nivelesClasificacion(null)).toEqual([]);
    expect(nivelesClasificacion('  ')).toEqual([]);
  });

  it('cuenta los meses completos entre dos fechas sin zona', () => {
    expect(mesesEntre('2026-05-09T08:00:00', CORTE)).toBe(6);
    expect(mesesEntre('2026-05-09T08:00:01', CORTE)).toBe(5);
    expect(mesesEntre('2025-11-10T00:00:00', CORTE)).toBe(11);
    expect(mesesEntre('2023-11-09T08:00:00', CORTE)).toBe(36);
  });

  it('pone cada entrada en su tramo de antigüedad, y lo que no tiene fecha aparte', () => {
    expect(tramoAntiguedad('2026-10-30T11:13:38', CORTE)).toBe(
      'Menos de 6 meses',
    );
    expect(tramoAntiguedad('2026-05-09T08:00:00', CORTE)).toBe('6 a 12 meses');
    expect(tramoAntiguedad('2025-11-09T08:00:00', CORTE)).toBe('1 a 2 años');
    expect(tramoAntiguedad('2024-11-08T00:00:00', CORTE)).toBe('2 a 3 años');
    expect(tramoAntiguedad('2019-07-08T18:19:07', CORTE)).toBe('Más de 3 años');
    expect(tramoAntiguedad(null, CORTE)).toBe(SIN_COSTO);
  });

  it('agrupa importes, unidades, filas y artículos, y ordena por importe', () => {
    const r = resumir(
      [
        fila(),
        fila({
          fechaEntrada: '2024-08-13T09:07:12',
          cantidad: 3,
          importePesos: 7675.24,
          importePesosOc: 7675.24,
        }),
        fila({
          parte: '2000836',
          clasificacion: 'GASES \\ MEZCLA',
          moneda: 'MXN',
          cantidad: 1,
          importePesos: 31081.73,
          importePesosOc: 31081.73,
          fechaEntrada: '2025-11-12T16:02:11',
        }),
        fila({
          parte: '2004768',
          clasificacion: null,
          moneda: null,
          cantidad: 2,
          importePesos: null,
          importePesosOc: null,
          fechaEntrada: null,
          origen: 'Sin entrada con costo',
        }),
      ],
      CORTE,
    );
    expect(
      r.clasificacion.map((g) => [g.clave, g.importe, g.filas, g.articulos]),
    ).toEqual([
      ['GASES', 31081.73, 1, 1],
      ['PARTES', 18544.09, 2, 1],
      [SIN_CLASIFICACION, 0, 1, 1],
    ]);
    expect(r.subclasificacion.map((g) => g.clave)).toEqual([
      'GASES / MEZCLA',
      'PARTES / ELE',
      SIN_CLASIFICACION,
    ]);
    // Los tramos van en su orden fijo y solo los que tienen algo
    // 2025-11-12 queda a 11 meses del corte: todavía "6 a 12 meses"
    expect(r.antiguedad.map((g) => g.clave)).toEqual([
      'Menos de 6 meses',
      '6 a 12 meses',
      '2 a 3 años',
      SIN_COSTO,
    ]);
    expect(TRAMOS_ANTIGUEDAD.indexOf(r.antiguedad[1].clave)).toBeLessThan(
      TRAMOS_ANTIGUEDAD.indexOf(r.antiguedad[2].clave),
    );
    expect(r.moneda.find((g) => g.clave === 'USD')).toMatchObject({
      importe: 18544.09,
      importeOc: 18221.24,
      unidades: 7,
    });
    expect(r.moneda.find((g) => g.clave === SIN_COSTO)).toMatchObject({
      importe: 0,
      unidades: 2,
    });
    expect(r.origen.map((g) => g.clave)).toEqual([
      'Recepción',
      'Sin entrada con costo',
    ]);
    expect(r.mayores.map((a) => [a.parte, a.importe, a.cantidad])).toEqual([
      ['2000836', 31081.73, 1],
      ['2004375', 18544.09, 7],
      ['2004768', 0, 2],
    ]);
  });

  it('limita los artículos de mayor importe', () => {
    const filas = Array.from({ length: 15 }, (_, i) =>
      fila({ parte: String(2000000 + i), importePesos: i }),
    );
    expect(resumir(filas, CORTE, 10).mayores).toHaveLength(10);
    expect(resumir(filas, CORTE).mayores[0].parte).toBe('2000014');
  });

  it('los grupos suman el total: no se redondean a centavos uno por uno', () => {
    // A centavos serían 0.33 + 0.33 + 0.33 = 0.99, y el total es 1.00
    const filas = ['USD', 'MXN', 'EUR'].map((moneda) =>
      fila({ moneda, importePesos: 0.334, importePesosOc: 0.334 }),
    );
    const r = resumir(filas, CORTE);
    const suma = r.moneda.reduce((s, g) => s + g.importe, 0);
    expect(suma).toBeCloseTo(1.002, 9);
    expect(r.moneda[0].importe).toBe(0.334);
  });

  it('con el tipo de cambio de la OC, la lista de mayor importe es la suya', () => {
    const filas = [
      fila({ parte: 'A', importePesos: 300, importePesosOc: 100 }),
      fila({ parte: 'B', importePesos: 200, importePesosOc: 250 }),
      fila({ parte: 'C', importePesos: 100, importePesosOc: 300 }),
    ];
    const r = resumir(filas, CORTE, 2);
    expect(r.mayores.map((a) => a.parte)).toEqual(['A', 'B']);
    expect(r.mayoresOc.map((a) => a.parte)).toEqual(['C', 'B']);
  });
});
