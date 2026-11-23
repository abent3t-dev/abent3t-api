import { createHash } from 'crypto';
import {
  FORMATO_PAQUETE,
  huellaPaquete,
  validarPaquete,
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
