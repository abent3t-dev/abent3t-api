import { createHash } from 'crypto';
import {
  FORMATO_V1 as FORMATO_PAQUETE,
  FORMATO_V2,
  huellaPaquete,
  validarPaquete,
  type DevolucionPaquete,
  type FilaPaquete,
  type PaqueteCorte,
} from './almacen-carga';

const excel = Buffer.from('PK\u0003\u0004 excel de prueba');
const sha = createHash('sha256').update(excel).digest('hex');

const fila = (o: Partial<FilaPaquete> = {}): FilaPaquete => ({
  orden: 1,
  parte: '2004375',
  descripcion: 'INTERRUPTOR',
  almacen: 'CENTRAL',
  almacenFisico: 'CA8A',
  clasificacion: 'PARTES \\ ELE \\ INTERR',
  costo: 145.56,
  moneda: 'USD',
  cantidad: 4,
  unidad: 'UN',
  fechaEntrada: '2026-10-30T11:13:38',
  fechaCaptura: '2026-10-30T11:13:38',
  tipoCambio: 18.6673,
  importePesos: 145.56 * 4 * 18.6673,
  tipoCambioOc: 18.1128,
  importePesosOc: 145.56 * 4 * 18.1128,
  origen: 'Recepción',
  oc: 'PO104940/1',
  fuenteTc: 'USD→MXN del 2026-10-30',
  fuenteTcOc: 'Maximo, en la entrada (el de la OC)',
  saldoArticulo: 6,
  regresaronRecientes: null,
  herramienta: false,
  enSuInventario: true,
  unidadEntrada: 'UN',
  nota: null,
  ...o,
});

const sinEntrada = fila({
  orden: 3,
  parte: '2004768',
  costo: null,
  moneda: null,
  fechaEntrada: null,
  fechaCaptura: null,
  tipoCambio: null,
  importePesos: null,
  tipoCambioOc: null,
  importePesosOc: null,
  origen: 'Sin entrada con costo',
  cantidad: 2,
  saldoArticulo: 2,
});

function paquete(
  filas: FilaPaquete[] = [
    fila(),
    fila({
      orden: 2,
      cantidad: 2,
      costo: 135.82,
      moneda: 'MXN',
      tipoCambio: 1,
      tipoCambioOc: 1,
      importePesos: 271.64,
      importePesosOc: 271.64,
    }),
    sinEntrada,
  ],
): PaqueteCorte {
  const pesos = filas.reduce((s, f) => s + (f.importePesos ?? 0), 0);
  const pesosOc = filas.reduce((s, f) => s + (f.importePesosOc ?? 0), 0);
  return {
    formato: FORMATO_PAQUETE,
    almacen: 'CENTRAL',
    fechaCorte: '2026-11-09T08:00:00',
    titulo: 'Inventario al corte',
    fuente: 'Maximo',
    totales: {
      pesos,
      pesosOc,
      articulos: new Set(filas.map((f) => f.parte)).size,
      unidades: filas.reduce((s, f) => s + f.cantidad, 0),
      sinValuarArticulos: 1,
      sinValuarUnidades: 2,
    },
    notas: [['Corte', '9 de noviembre de 2026 a las 8:00 a. m.']],
    archivo: {
      nombre: 'Inventario.xlsx',
      sha256: sha,
      base64: excel.toString('base64'),
    },
    existencias: filas,
  };
}

describe('Almacén — validación del paquete de un corte', () => {
  it('acepta un paquete coherente', () => {
    expect(validarPaquete(paquete())).toEqual([]);
  });

  it('rechaza un Excel cuyos bytes no dan su sha256', () => {
    const p = paquete();
    p.archivo.base64 = Buffer.from('otro archivo').toString('base64');
    expect(validarPaquete(p).join('\n')).toMatch(
      /Excel del paquete está dañado/,
    );
  });

  it('rechaza nombres de Excel que no van en la cabecera de la descarga', () => {
    for (const nombre of [
      'Inventario revisión.xlsx',
      'Inventario — 30-nov.xlsx',
      'Inventario "v2".xlsx',
      'a\\b.xlsx',
      'Inventario.XLSX',
      'Inventario.csv',
      `${'x'.repeat(156)}.xlsx`,
    ]) {
      const p = paquete();
      p.archivo.nombre = nombre;
      expect(validarPaquete(p).join('\n')).toMatch(/nombre del Excel/);
    }
    const p = paquete();
    p.archivo.nombre = 'Inventario al corte 9-nov-2026 8 am.xlsx';
    expect(validarPaquete(p)).toEqual([]);
  });

  it('la huella del paquete cubre las filas y no depende del orden de las claves', () => {
    const p = paquete();
    const h = huellaPaquete(p);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Mismo contenido con las claves de cada fila al revés: misma huella
    const alReves = {
      ...p,
      existencias: p.existencias.map(
        (f) =>
          Object.fromEntries(
            Object.entries(f).reverse(),
          ) as unknown as FilaPaquete,
      ),
    };
    expect(huellaPaquete(alReves)).toBe(h);
    // Mismo Excel con otra clasificación: otra huella
    const otra = paquete();
    otra.existencias[0].clasificacion = 'HERRAMIENTAS';
    expect(otra.archivo.sha256).toBe(p.archivo.sha256);
    expect(huellaPaquete(otra)).not.toBe(h);
  });

  it('rechaza totales que no son la suma de las filas', () => {
    const p = paquete();
    p.totales.pesos += 1;
    p.totales.articulos = 5;
    const e = validarPaquete(p).join('\n');
    expect(e).toMatch(/total en pesos/);
    expect(e).toMatch(/artículos: 5/);
  });

  it('rechaza una fila cuyo importe no es costo × cantidad × tipo de cambio', () => {
    const p = paquete([
      fila({ importePesos: 1 }),
      fila({ orden: 2, cantidad: 2 }),
      sinEntrada,
    ]);
    expect(validarPaquete(p).join('\n')).toMatch(/fila 1 .*importe en pesos/);
  });

  it('rechaza filas cuyo total no da el saldo del artículo', () => {
    const p = paquete([fila(), sinEntrada]);
    expect(validarPaquete(p).join('\n')).toMatch(
      /2004375: sus filas suman 4 y su saldo es 6/,
    );
  });

  it('rechaza una fila "Sin entrada con costo" con costo y una valuada sin él', () => {
    const p = paquete([
      fila(),
      fila({ orden: 2, cantidad: 2, costo: null }),
      { ...sinEntrada, costo: 5 },
    ]);
    const e = validarPaquete(p).join('\n');
    expect(e).toMatch(/fila 2 .*sin costo/);
    expect(e).toMatch(/fila 3 .*trae costo/);
  });

  it('rechaza órdenes repetidos, orígenes desconocidos, entradas después del corte y pesos con tipo de cambio distinto de 1', () => {
    const p = paquete([
      fila(),
      fila({ orden: 1, cantidad: 2, origen: 'Otro' }),
      fila({
        orden: 4,
        parte: '2000836',
        saldoArticulo: 1,
        cantidad: 1,
        fechaEntrada: '2026-11-10T09:00:00',
        moneda: 'MXN',
        costo: 100,
        tipoCambio: 18,
        importePesos: 1800,
        tipoCambioOc: 18,
        importePesosOc: 1800,
      }),
      sinEntrada,
    ]);
    const e = validarPaquete(p).join('\n');
    expect(e).toMatch(/orden repetido/);
    expect(e).toMatch(/origen "Otro"/);
    expect(e).toMatch(/entrada después del corte/);
    expect(e).toMatch(/en pesos el tipo de cambio debe ser 1/);
  });

  it('rechaza formato, fecha de corte y notas mal formadas', () => {
    const p = paquete();
    p.formato = 'otro/9';
    p.fechaCorte = '2026-11-09 08:00';
    (p as unknown as { notas: unknown }).notas = { a: 1 };
    const e = validarPaquete(p).join('\n');
    expect(e).toMatch(/formato/);
    expect(e).toMatch(/fecha de corte/);
    expect(e).toMatch(/notas/);
  });
});

// Formato 2 (0027): todas las ubicaciones, lo que va sin costo con su motivo y las devoluciones sin OT.
const devolucion = (o: Partial<DevolucionPaquete> = {}): DevolucionPaquete => ({
  orden: 1,
  fecha: '2026-10-23T10:00:00',
  fechaCaptura: '2026-10-23T10:00:00',
  documento: '17527',
  documentoDescripcion: 'Devolución',
  almacen: 'CENTRAL',
  anaquel: 'CA8B',
  parte: '2004375',
  descripcion: 'INTERRUPTOR',
  cantidad: 2,
  unidad: 'UN',
  costoMaximoUsd: 0,
  costo: 145.56,
  moneda: 'USD',
  tipoCambio: 18.6673,
  importePesos: 145.56 * 2 * 18.6673,
  tipoCambioOc: 18.1128,
  importePesosOc: 145.56 * 2 * 18.1128,
  valuacion: 'Con la recepción más reciente del artículo',
  oc: 'PO104940/1',
  observacion: null,
  marcas: ['Costo 0 en Maximo'],
  salioAntes: 6,
  salio12m: 2,
  ultimaSalida: '2026-09-01T10:00:00',
  otUltimaSalida: 'WO117000',
  saldoAlmacen: 6,
  saldoOtras: 0,
  ...o,
});

function paqueteV2(
  o: { filas?: FilaPaquete[]; devoluciones?: DevolucionPaquete[] } = {},
): PaqueteCorte {
  const filas = o.filas ?? [
    fila(),
    fila({
      orden: 2,
      cantidad: 2,
      costo: 135.82,
      moneda: 'MXN',
      tipoCambio: 1,
      tipoCambioOc: 1,
      importePesos: 271.64,
      importePesosOc: 271.64,
    }),
    {
      ...sinEntrada,
      motivo: 'Sin compras en Maximo',
      comoLlego: 'con alta del artículo con saldo (2019-05-31)',
    },
    // El mismo artículo en otro almacén, con su propio saldo
    fila({
      orden: 4,
      almacen: 'CONT-1',
      cantidad: 3,
      saldoArticulo: 3,
      enSuInventario: null,
      importePesos: 145.56 * 3 * 18.6673,
      importePesosOc: 145.56 * 3 * 18.1128,
    }),
    {
      ...sinEntrada,
      orden: 5,
      almacen: 'MAAB1',
      parte: '2701700',
      cantidad: 1,
      saldoArticulo: 1,
      enSuInventario: null,
      herramienta: true,
      motivo: 'Devolución en 0 y Sin compras en Maximo',
      comoLlego: 'por traslado desde CONT-1',
    },
  ];
  const pesos = filas.reduce((s, f) => s + (f.importePesos ?? 0), 0);
  const pesosOc = filas.reduce((s, f) => s + (f.importePesosOc ?? 0), 0);
  const sin = filas.filter((f) => f.origen === 'Sin entrada con costo');
  return {
    ...paquete(),
    formato: FORMATO_V2,
    almacen: 'TODOS',
    versionReporte: 2,
    totales: {
      pesos,
      pesosOc,
      articulos: new Set(filas.map((f) => f.parte)).size,
      unidades: filas.reduce((s, f) => s + f.cantidad, 0),
      sinValuarArticulos: new Set(sin.map((f) => f.parte)).size,
      sinValuarUnidades: sin.reduce((s, f) => s + f.cantidad, 0),
    },
    existencias: filas,
    ubicaciones: [
      {
        clave: 'CENTRAL',
        descripcion: 'Almacén central',
        tipo: 'STOREROOM',
        grupo: 'CENTRAL',
      },
      {
        clave: 'CONT-1',
        descripcion: 'Contenedor negro',
        tipo: 'STOREROOM',
        grupo: 'Almacenes y contenedores',
      },
      {
        clave: 'MAAB1',
        descripcion: 'Caja de herramientas',
        tipo: 'LABOR',
        grupo: 'Cajas de herramientas',
      },
    ],
    devoluciones: o.devoluciones ?? [
      devolucion(),
      devolucion({
        orden: 2,
        parte: '2004768',
        almacen: 'CENTRAL',
        costo: null,
        moneda: null,
        tipoCambio: null,
        importePesos: null,
        tipoCambioOc: null,
        importePesosOc: null,
        valuacion: 'Sin costo',
      }),
    ],
    devolucionesPorMes: [
      { mes: '2024-12', lineas: 3, unidades: 5 },
      { mes: '2026-10', lineas: 2, unidades: 3 },
    ],
  };
}

describe('Almacén — paquete del formato 2 (todas las ubicaciones)', () => {
  it('acepta un paquete coherente con varios almacenes, lo que va sin costo y las devoluciones', () => {
    expect(validarPaquete(paqueteV2())).toEqual([]);
  });

  it('cuadra el saldo por artículo y almacén', () => {
    const p = paqueteV2();
    p.existencias[3].saldoArticulo = 5;
    expect(validarPaquete(p).join('\n')).toMatch(
      /CONT-1, 2004375: sus filas suman 3 y su saldo es 5/,
    );
  });

  it('rechaza almacenes fuera de la lista, grupos desconocidos y ubicaciones repetidas', () => {
    const p = paqueteV2();
    p.existencias[3].almacen = 'CONT-9';
    p.ubicaciones![2].grupo = 'Otro';
    p.ubicaciones!.push({ ...p.ubicaciones![0] });
    const e = validarPaquete(p).join('\n');
    expect(e).toMatch(/su almacén no está en las ubicaciones/);
    expect(e).toMatch(/grupo "Otro" desconocido/);
    expect(e).toMatch(/la ubicación CENTRAL se repite/);
  });

  it('lo que va sin costo necesita un motivo conocido, y lo que tiene costo no lleva motivo', () => {
    const p = paqueteV2();
    p.existencias[2].motivo = null;
    p.existencias[4].motivo = 'Otro motivo';
    p.existencias[0].motivo = 'Sin compras en Maximo';
    const e = validarPaquete(p).join('\n');
    expect(e.match(/necesita un motivo conocido/g)).toHaveLength(2);
    expect(e).toMatch(/tiene costo y trae motivo/);
  });

  it('"en su inventario" solo aplica en CENTRAL', () => {
    const p = paqueteV2();
    p.existencias[3].enSuInventario = false;
    p.existencias[0].enSuInventario = null;
    expect(
      validarPaquete(p)
        .join('\n')
        .match(/solo aplica en CENTRAL/g),
    ).toHaveLength(2);
  });

  it('revisa cada devolución: orden, fecha, valuación completa, aritmética y pesos', () => {
    const p = paqueteV2({
      devoluciones: [
        devolucion(),
        devolucion({ orden: 1, fecha: '2026-11-10T09:00:00' }),
        devolucion({ orden: 3, costo: 10, moneda: 'USD', tipoCambio: null }),
        devolucion({ orden: 4, importePesos: 1 }),
        devolucion({
          orden: 5,
          moneda: 'MXN',
          costo: 100,
          tipoCambio: 18,
          importePesos: 3600,
          tipoCambioOc: 18,
          importePesosOc: 3600,
        }),
        devolucion({ orden: 6, cantidad: 0 }),
      ],
    });
    const e = validarPaquete(p).join('\n');
    expect(e).toMatch(/devolución 1 .*orden inválido o repetido/);
    expect(e).toMatch(/fecha inválida o después del corte/);
    expect(e).toMatch(/devolución 3 .*valuada a medias/);
    expect(e).toMatch(
      /devolución 4 .*importe ≠ costo × cantidad × tipo de cambio/,
    );
    expect(e).toMatch(/devolución 5 .*en pesos el tipo de cambio debe ser 1/);
    expect(e).toMatch(/devolución 6 .*cantidad 0/);
  });

  it('rechaza una serie por mes desordenada o después del corte, y una versión del reporte inválida', () => {
    const p = paqueteV2();
    p.devolucionesPorMes = [
      { mes: '2026-11', lineas: 1, unidades: 1 },
      { mes: '2026-10', lineas: 1, unidades: 1 },
    ];
    p.versionReporte = 0;
    const e = validarPaquete(p).join('\n');
    expect(e).toMatch(/la serie por mes/);
    expect(e).toMatch(/versión del reporte/);
    p.devolucionesPorMes = [{ mes: '2026-12', lineas: 1, unidades: 1 }];
    expect(validarPaquete(p).join('\n')).toMatch(/la serie por mes/);
  });

  it('el formato 2 es de todos los almacenes y cada ubicación tiene filas', () => {
    const p = paqueteV2();
    p.almacen = 'CENTRAL';
    p.ubicaciones!.push({
      clave: 'CONT-9',
      descripcion: 'Vacío',
      tipo: 'STOREROOM',
      grupo: 'Almacenes y contenedores',
    });
    const e = validarPaquete(p).join('\n');
    expect(e).toMatch(/almacén "TODOS", no "CENTRAL"/);
    expect(e).toMatch(
      /la ubicación CONT-9 no tiene existencias ni devoluciones/,
    );
  });

  it('rechaza marcas desconocidas, una última salida posterior a la devolución y una serie por mes que no cuadra con el detalle', () => {
    const p = paqueteV2({
      devoluciones: [
        devolucion({ marcas: ['Otra marca'] }),
        devolucion({ orden: 2, ultimaSalida: '2026-10-30T10:00:00' }),
        devolucion({ orden: 3, fechaCaptura: '23/10/2026' }),
      ],
    });
    const e = validarPaquete(p).join('\n');
    expect(e).toMatch(/devolución 1 .*marcas conocidas/);
    expect(e).toMatch(/devolución 2 .*última salida/);
    expect(e).toMatch(/devolución 3 .*fecha de captura inválida/);
    expect(e).toMatch(
      /la serie por mes dice 2 devoluciones en 2026-10 y el detalle trae 3/,
    );
  });

  it('acepta el motivo "Solo compras de salida directa"', () => {
    const p = paqueteV2();
    p.existencias[2].motivo = 'Solo compras de salida directa';
    expect(validarPaquete(p)).toEqual([]);
  });

  it('la huella del formato 2 cubre las devoluciones y el motivo; la del formato 1 no cambia', () => {
    const p = paqueteV2();
    const h = huellaPaquete(p);
    const otra = paqueteV2();
    otra.devoluciones![0].observacion = 'regresó de la limpieza';
    expect(huellaPaquete(otra)).not.toBe(h);
    const otraMotivo = paqueteV2();
    otraMotivo.existencias[2].motivo = 'Sus compras no alcanzan';
    expect(huellaPaquete(otraMotivo)).not.toBe(h);
    // En el formato 1, los campos nuevos no entran en la huella.
    const v1 = paquete();
    const conExtras = {
      ...paquete(),
      existencias: paquete().existencias.map((f) => ({ ...f, motivo: 'x' })),
    };
    expect(huellaPaquete(conExtras)).toBe(huellaPaquete(v1));
  });
});
