import {
  dolarDeLasFormulas,
  filasSumadas,
  leerHoja,
  letraColumna,
  lineasDeHoja,
  mapearLinea,
  montosDeLinea,
  type CeldaHoja,
  type ContextoCatalogo,
  type HojaPlantilla,
} from './plantilla';

/** Hoja de prueba: celdas por dirección ("R7": {v, f}) y filas ocultas. */
function hoja(
  celdas: Record<string, CeldaHoja | number | string>,
  ocultas: number[] = [],
): HojaPlantilla {
  const mapa = new Map<string, CeldaHoja>();
  let maxFila = 1;
  let maxCol = 1;
  for (const [dir, c] of Object.entries(celdas)) {
    const m = /^([A-Z]+)(\d+)$/.exec(dir)!;
    const col = m[1]
      .split('')
      .reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    maxFila = Math.max(maxFila, Number(m[2]));
    maxCol = Math.max(maxCol, col);
    mapa.set(dir, typeof c === 'object' ? c : { v: c });
  }
  return {
    nombre: 'Hoja',
    maxFila,
    maxCol,
    celda: (f, c) => mapa.get(`${letraColumna(c)}${f}`),
    oculta: (f) => ocultas.includes(f),
  };
}

const MESES = [
  '01 Enero',
  '02 Febrero',
  '03 Marzo',
  '04 Abril',
  '05 Mayo',
  '06 Junio',
  '07 Julio',
  '08 Agosto',
  '09 Septiembre',
  '10 Octubre',
  '11 Noviembre',
  '12 Diciembre',
];
const COL_2026 = 4; // D
const COL_2027 = 18; // R

/** Plantilla como la de Compras: real en D:O, 2027 en R:AC y FY en AD. */
function plantilla(
  filas: Record<
    number,
    {
      etiqueta?: string;
      prioridad?: string;
      m2027?: Array<CeldaHoja | number | null>;
      m2026?: Array<CeldaHoja | null>;
    }
  >,
  extra: Record<string, CeldaHoja | number | string> = {},
  ocultas: number[] = [],
) {
  const celdas: Record<string, CeldaHoja | number | string> = {
    R3: 'Inflación: 3.7',
    S3: 1.037,
    D5: 'Real 2026',
    R5: 2027,
    B6: 'Gastos',
    AD6: 'FY',
    ...extra,
  };
  MESES.forEach((m, i) => {
    celdas[`${letraColumna(COL_2026 + i)}6`] = m;
    celdas[`${letraColumna(COL_2027 + i)}6`] = m;
  });
  for (const [n, f] of Object.entries(filas)) {
    if (f.etiqueta) celdas[`B${n}`] = f.etiqueta;
    if (f.prioridad) celdas[`A${n}`] = f.prioridad;
    (f.m2027 ?? []).forEach((v, i) => {
      if (v !== null)
        celdas[`${letraColumna(COL_2027 + i)}${n}`] =
          typeof v === 'number' ? { v } : v;
    });
    (f.m2026 ?? []).forEach((v, i) => {
      if (v) celdas[`${letraColumna(COL_2026 + i)}${n}`] = v;
    });
  }
  return hoja(celdas, ocultas);
}

const doce = (v: number) => Array.from({ length: 12 }, () => v);
const sumaCol = (fila: number, de: number, a: number) =>
  Array.from({ length: 12 }, (_, i) => {
    const c = letraColumna(COL_2027 + i);
    return { f: `SUM(${c}${de}:${c}${a})`, v: null } as CeldaHoja;
  });

const CTX: ContextoCatalogo = {
  categorias: [
    {
      nombre: 'Servicios Profesionales',
      clasificaciones: ['Servicios Profesionales', 'Asesoría Legal'],
    },
    {
      nombre: 'Comunicaciones',
      clasificaciones: ['Internet', 'Otras Comunicaciones', 'Internet Tabasco'],
    },
    {
      nombre: 'Otras Comunicaciones',
      clasificaciones: ['Otras Comunicaciones'],
    },
    {
      nombre: 'Viajes',
      clasificaciones: ['Hospedaje', 'Transporte', 'Viajes'],
    },
    { nombre: 'Beneficios', clasificaciones: ['Autos', 'Gimnasio'] },
    {
      nombre: 'Instalaciones Técnicas',
      clasificaciones: ['Instalaciones Técnicas', 'Medidores'],
    },
    {
      nombre: 'Controles Volumétricos',
      clasificaciones: ['Controles Volumétricos'],
    },
    {
      nombre: 'GE Fixed Fee + Variable Fee',
      clasificaciones: ['GE Fixed Fee + Variable Fee'],
    },
  ],
  pares: {
    Compras: [
      ['Servicios Profesionales', 'Servicios Profesionales'],
      ['Viajes', 'Hospedaje'],
      ['Viajes', 'Transporte'],
    ],
    Legal: [
      ['Servicios Profesionales', 'Servicios Profesionales'],
      ['Servicios Profesionales', 'Asesoría Legal'],
    ],
    Planta: [
      ['Comunicaciones', 'Internet Tabasco'],
      ['Otras Comunicaciones', 'Otras Comunicaciones'],
    ],
    'Recursos Humanos': [
      ['Beneficios', 'Autos'],
      ['Beneficios', 'Gimnasio'],
    ],
    Medición: [
      ['Instalaciones Técnicas', 'Instalaciones Técnicas'],
      ['Instalaciones Técnicas', 'Medidores'],
    ],
    GE: [['GE Fixed Fee + Variable Fee', 'GE Fixed Fee + Variable Fee']],
  },
};

describe('filasSumadas', () => {
  it('SUM de un rango y sumas de celdas en la misma columna', () => {
    expect(filasSumadas('SUM(R9:R12)', 18)).toEqual([9, 10, 11, 12]);
    expect(filasSumadas('=+R8+R13+R15', 18)).toEqual([8, 13, 15]);
  });

  it('columnas de dos letras (AA27 no es A27)', () => {
    expect(filasSumadas('+SUM(AA27:AA31)', 27)).toEqual([27, 28, 29, 30, 31]);
  });

  it('no es suma: constantes, productos, otra columna u otra hoja', () => {
    expect(filasSumadas('+T18+480000', 20)).toBeNull();
    expect(filasSumadas('50000*$T$2', 19)).toBeNull();
    expect(filasSumadas('+T12', 21)).toBeNull();
    expect(filasSumadas('Viajes!P29', 19)).toBeNull();
  });
});

describe('leerHoja', () => {
  const h = plantilla({
    7: {
      etiqueta: 'Compras',
      m2027: Array.from({ length: 12 }, (_, i) => ({
        f: `+${letraColumna(COL_2027 + i)}8+${letraColumna(COL_2027 + i)}11`,
        v: null,
      })),
    },
    8: { etiqueta: 'Servicios Profesionales', m2027: sumaCol(8, 9, 10) },
    9: {
      etiqueta: 'AQUILES MEXICO',
      prioridad: 'Contractual',
      m2027: [0, 0, 0, 0, 0, 190000],
    },
    10: { etiqueta: 'Mapeo de Proceso', m2027: doce(100000) },
    11: {
      etiqueta: 'Viajes',
      prioridad: 'Deseable',
      m2027: sumaCol(11, 12, 12),
    },
    12: { etiqueta: 'Hospedaje', m2027: [10370] },
    20: {
      etiqueta: 'Total',
      m2027: Array.from({ length: 12 }, (_, i) => ({
        f: `+${letraColumna(COL_2027 + i)}7`,
        v: null,
      })),
    },
  });
  const l = leerHoja(h);

  it('encuentra el bloque 2027 por su marca, la etiqueta, la prioridad y la inflación', () => {
    expect(l.encabezado).toBe(6);
    expect(l.columnas2027[0]).toBe(COL_2027);
    expect(l.columnaFY).toBe(COL_2027 + 12);
    expect(l.columnaEtiqueta).toBe(2);
    expect(l.columnaPrioridad).toBe(1);
    expect(l.inflacion).toEqual({ pct: 3.7, factor: 1.037, celdas: ['S3'] });
  });

  it('arma el árbol con las sumas; el Total no es padre del área', () => {
    expect(l.filas.get(7)?.hijos).toEqual([8, 11]);
    expect(l.filas.get(9)?.padre).toBe(8);
    expect(l.filas.get(12)?.padre).toBe(11);
    expect(l.filas.get(7)?.padre).toBeNull();
    expect(l.raices).toEqual([7, 20]);
  });

  it('sin marca 2027 y con dos bloques, se niega', () => {
    const sinMarca = plantilla({}, { R5: 'Budget' });
    expect(() => leerHoja(sinMarca)).toThrow(
      /ningún bloque de meses dice 2027/,
    );
  });
});

describe('montosDeLinea', () => {
  const params = {
    inflacion: { pct: 3.7, factor: 1.037, celdas: ['S3'] },
    usd: 19,
  };

  it('x*19 va en dólares', () => {
    const m = montosDeLinea(
      [null, null, 18755280, null],
      [null, null, '987120*19', null],
      params,
    );
    expect(m).toMatchObject({
      moneda: 'USD',
      indice: 'precio_acordado',
      meses: [{ mes: 3, monto: '987120.00' }],
    });
  });

  it('x por la celda de la inflación (o por 1.037) va con índice inflación', () => {
    const m = montosDeLinea(
      [51850, 51850],
      ['50000*$S$3', '50000*1.037'],
      params,
    );
    expect(m).toMatchObject({
      moneda: 'MXN',
      indice: 'inflacion',
      meses: [
        { mes: 1, monto: '50000.00' },
        { mes: 2, monto: '50000.00' },
      ],
    });
  });

  it('mezcla de fórmulas en el año: en pesos', () => {
    const m = montosDeLinea(
      [null, 77775, 75000],
      [null, '75000*$S$3', null],
      params,
    );
    expect(m.moneda).toBe('MXN');
    expect(m.indice).toBe('precio_acordado');
    expect(m.nota).toMatch(/mezcla/);
  });

  it('un total repartido: el último mes absorbe los centavos', () => {
    const v = 1000000 / 12;
    const m = montosDeLinea(
      doce(v),
      doce(0).map(() => '1000000/12'),
      params,
    );
    expect(m.meses[0].monto).toBe('83333.33');
    expect(m.meses[11].monto).toBe('83333.37');
    expect(m.meses.reduce((s, x) => s + Number(x.monto), 0).toFixed(2)).toBe(
      '1000000.00',
    );
  });

  it('dólares que no dan centavos exactos: en pesos', () => {
    const m = montosDeLinea([123456.78], ['6497.725263*19'], params);
    expect(m.moneda).toBe('MXN');
  });
});

describe('mapearLinea', () => {
  it('categoría cerca del área y clasificación cerca de la línea, del COA del departamento', () => {
    expect(
      mapearLinea(
        ['PEREZ-LLORCA', 'Asesoría Legal', 'Servicios Profesionales'],
        'Legal',
        CTX,
      ),
    ).toMatchObject({
      categoria: 'Servicios Profesionales',
      clasificacion: 'Asesoría Legal',
      como: 'coa',
    });
  });

  it('sin clasificación en el camino: la del mismo nombre que la categoría', () => {
    expect(
      mapearLinea(
        ['Mapeo de Proceso', 'Servicios Profesionales'],
        'Compras',
        CTX,
      ),
    ).toMatchObject({
      clasificacion: 'Servicios Profesionales',
      como: 'por_omision',
    });
  });

  it('el beneficiario va al departamento de la línea', () => {
    expect(
      mapearLinea(
        ['Autos Dirección General', 'Autos', 'Beneficios'],
        'Recursos Humanos',
        CTX,
      ),
    ).toMatchObject({
      clasificacion: 'Autos',
      departamento: 'Dirección General',
      como: 'beneficiario',
    });
  });

  it('una clasificación que el COA del departamento pone en otra categoría', () => {
    expect(
      mapearLinea(
        ['TELEFONOS DE MEXICO', 'Otras Comunicaciones', 'Comunicaciones'],
        'Planta',
        CTX,
      ),
    ).toMatchObject({
      categoria: 'Otras Comunicaciones',
      clasificacion: 'Otras Comunicaciones',
      como: 'coa',
    });
  });

  it('alias documentado y categoría fuera del COA del departamento', () => {
    expect(
      mapearLinea(
        [
          'Adecuaciones GTR',
          'Mantenimiento Medidores',
          'Instalaciones Técnicas',
        ],
        'Medición',
        CTX,
      ),
    ).toMatchObject({
      clasificacion: 'Medidores',
      como: 'alias',
    });
    expect(mapearLinea(['Uber', 'Viajes'], 'Compras', CTX)).toMatchObject({
      clasificacion: 'Transporte',
      como: 'alias',
    });
    expect(
      mapearLinea(
        ['UVX SAPI DE CV', 'Certificacion de Controles Volumetricos'],
        'Planta',
        CTX,
      ),
    ).toMatchObject({
      categoria: 'Controles Volumétricos',
      como: 'fuera_del_coa',
    });
  });

  it('lo que no se encuentra va a Por clasificar (no se inventa)', () => {
    expect(
      mapearLinea(['Bono', 'Beneficios'], 'Recursos Humanos', CTX),
    ).toMatchObject({
      categoria: 'Beneficios',
      clasificacion: 'Por clasificar',
      como: 'por_clasificar',
    });
    expect(
      mapearLinea(['Algo', 'Categoría rara'], 'Compras', CTX),
    ).toMatchObject({
      categoria: 'Por clasificar',
      como: 'por_clasificar',
    });
  });
});

describe('lineasDeHoja', () => {
  const params = {
    inflacion: { pct: 3.7, factor: 1.037, celdas: ['S3'] },
    usd: 19,
  };

  it('cuadra con el archivo y explica una suma con celdas tecleadas', () => {
    const fila8 = sumaCol(8, 9, 10);
    fila8[1] = { v: 0 }; // tecleada: no suma el febrero de sus filas
    const h = plantilla(
      {
        7: {
          etiqueta: 'Compras',
          m2027: Array.from({ length: 12 }, (_, i) => ({
            f: `+${letraColumna(COL_2027 + i)}8`,
            v: i === 1 ? 0 : 100000,
          })),
        },
        8: {
          etiqueta: 'Servicios Profesionales',
          m2027: fila8.map((c, i) => ({ ...c, v: i === 1 ? 0 : 100000 })),
        },
        10: { etiqueta: 'Mapeo de Proceso', m2027: doce(100000) },
      },
      { AD7: 1100000 },
    );
    const r = lineasDeHoja(
      leerHoja(h),
      'Compras.xlsx',
      'Compras B-27',
      params,
      CTX,
    );
    expect(r.secciones).toHaveLength(1);
    expect(r.secciones[0]).toMatchObject({
      area: 'Compras',
      total_archivo: '1100000.00',
      total_lineas: '1200000.00',
      tipo_diferencia: 'explicada',
    });
    expect(r.diferencias[0]).toMatchObject({
      fila: 8,
      diferencia: '100000.00',
    });
    expect(r.diferencias[0].motivo).toMatch(
      /celdas tecleadas en vez de suma: S8/,
    );
    expect(r.secciones[0].lineas[0]).toMatchObject({
      ref: 'Compras B-27, Hoja!10',
      concepto: 'Mapeo de Proceso',
      total: '1200000.00',
    });
  });

  it('Facturado y Provisión pasan a la línea de arriba; un área oculta no se carga', () => {
    const h = plantilla(
      {
        7: { etiqueta: 'Costos GE', m2027: sumaCol(7, 8, 8) },
        8: {
          etiqueta: 'GE Fixed Fee + Variable Fee',
          prioridad: 'Contractual',
          m2027: sumaCol(8, 9, 10),
        },
        9: { etiqueta: 'Facturado', m2027: doce(3093390) },
        10: { etiqueta: 'Provisión' },
        15: {
          etiqueta: 'Compras',
          m2027: sumaCol(15, 16, 16).map((c) => ({ ...c, v: 1 })),
        },
        16: { etiqueta: 'Mapeo de Proceso', m2027: doce(1) },
      },
      {},
      [15, 16],
    );
    const r = lineasDeHoja(
      leerHoja(h),
      'Planta.xlsx',
      'Planta B-27',
      params,
      CTX,
    );
    expect(r.secciones.map((s) => s.area)).toEqual(['GE']);
    expect(r.secciones[0].lineas[0]).toMatchObject({
      concepto: 'GE Fixed Fee + Variable Fee',
      proveedor: '',
      prioridad: 'contractual',
      total: '37120680.00',
    });
    expect(r.secciones[0].lineas[0].notas[0]).toMatch(/fila "Facturado"/);
    expect(r.avisos.join(' ')).toMatch(/oculta/);
  });

  it('texto o fórmula sin valor en un monto es un problema, no un 0', () => {
    const h = plantilla({
      7: { etiqueta: 'Compras', m2027: sumaCol(7, 8, 8) },
      8: {
        etiqueta: 'Mapeo de Proceso',
        m2027: [{ v: '-' }, { f: '5*2', v: null }, 100],
      },
    });
    const r = lineasDeHoja(leerHoja(h), 'C.xlsx', 'C', params, CTX);
    expect(r.problemas.join(' | ')).toMatch(/texto "-"/);
    expect(r.problemas.join(' | ')).toMatch(/no trae valor guardado/);
  });
});

describe('dolarDeLasFormulas', () => {
  it('el multiplicador que más se usa entre 15 y 25', () => {
    const h = plantilla({
      7: { etiqueta: 'TI', m2027: sumaCol(7, 8, 9) },
      8: {
        etiqueta: 'Copilot',
        m2027: [
          { f: '4800*19', v: 91200 },
          { f: '4800*19', v: 91200 },
        ],
      },
      9: { etiqueta: 'Licencia', m2027: [{ f: '2400*18', v: 43200 }] },
    });
    expect(dolarDeLasFormulas([leerHoja(h)])).toBe(19);
  });
});
