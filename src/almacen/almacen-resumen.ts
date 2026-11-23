/**
 * Almacén — el resumen de un corte para las gráficas de la página: importe en
 * pesos (con el tipo de cambio del día de la entrada y con el de la OC),
 * unidades, filas y artículos, por clasificación, antigüedad de la entrada,
 * moneda y origen, más los artículos de mayor importe. Funciones puras: las
 * prueba almacen-resumen.spec.ts.
 */

/** Una fila de existencias, ya con números (lo que lee el service). */
export interface FilaExistencia {
  parte: string;
  descripcion: string;
  clasificacion: string | null;
  moneda: string | null;
  cantidad: number;
  unidad: string | null;
  /** Hora de México, sin zona: 'AAAA-MM-DDTHH:MM:SS'. */
  fechaEntrada: string | null;
  importePesos: number | null;
  importePesosOc: number | null;
  origen: string;
}

export interface Grupo {
  clave: string;
  importe: number;
  importeOc: number;
  unidades: number;
  filas: number;
  articulos: number;
}

export interface ArticuloMayor {
  parte: string;
  descripcion: string;
  importe: number;
  importeOc: number;
  cantidad: number;
  unidad: string | null;
}

export interface Resumen {
  clasificacion: Grupo[];
  subclasificacion: Grupo[];
  antiguedad: Grupo[];
  moneda: Grupo[];
  origen: Grupo[];
  /** Los de mayor importe con el tipo de cambio del día de la entrada… */
  mayores: ArticuloMayor[];
  /** …y con el de la OC (la lista puede cambiar: la página tiene los dos). */
  mayoresOc: ArticuloMayor[];
}

export const SIN_CLASIFICACION = 'Sin clasificación';
export const SIN_COSTO = 'Sin entrada con costo';

/** Los tramos de antigüedad, en el orden en que se muestran. */
export const TRAMOS_ANTIGUEDAD = [
  'Menos de 6 meses',
  '6 a 12 meses',
  '1 a 2 años',
  '2 a 3 años',
  'Más de 3 años',
  SIN_COSTO,
];

/** Partes de la clasificación ('PARTES \ MEC \ BOYA' → ['PARTES', 'MEC', 'BOYA']). */
export function nivelesClasificacion(c: string | null): string[] {
  return (c ?? '')
    .split('\\')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Meses completos entre dos fechas 'AAAA-MM-DDTHH:MM:SS' (sin zona). */
export function mesesEntre(desde: string, hasta: string): number {
  const [a, b] = [desde, hasta].map((f) => ({
    y: Number(f.slice(0, 4)),
    m: Number(f.slice(5, 7)),
    resto: f.slice(8, 19),
  }));
  let meses = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.resto < a.resto) meses -= 1;
  return meses;
}

export function tramoAntiguedad(
  fechaEntrada: string | null,
  fechaCorte: string,
): string {
  if (!fechaEntrada) return SIN_COSTO;
  const m = mesesEntre(fechaEntrada, fechaCorte);
  if (m < 6) return TRAMOS_ANTIGUEDAD[0];
  if (m < 12) return TRAMOS_ANTIGUEDAD[1];
  if (m < 24) return TRAMOS_ANTIGUEDAD[2];
  if (m < 36) return TRAMOS_ANTIGUEDAD[3];
  return TRAMOS_ANTIGUEDAD[4];
}

/**
 * Seis decimales, como numeric(20,6) en la base: quita el ruido de punto
 * flotante sin redondear a centavos. La página da formato; así los grupos
 * suman el total del corte (a centavos, la dona daba un centavo de más).
 */
const redondea = (x: number) => Math.round(x * 1e6) / 1e6;

function agrupar(
  filas: FilaExistencia[],
  clave: (f: FilaExistencia) => string,
  orden?: string[],
): Grupo[] {
  const g = new Map<string, Grupo & { partes: Set<string> }>();
  for (const f of filas) {
    const k = clave(f);
    let x = g.get(k);
    if (!x) {
      x = {
        clave: k,
        importe: 0,
        importeOc: 0,
        unidades: 0,
        filas: 0,
        articulos: 0,
        partes: new Set(),
      };
      g.set(k, x);
    }
    x.importe += f.importePesos ?? 0;
    x.importeOc += f.importePesosOc ?? 0;
    x.unidades += f.cantidad;
    x.filas += 1;
    x.partes.add(f.parte);
  }
  const lista = [...g.values()].map(({ partes, ...x }) => ({
    ...x,
    importe: redondea(x.importe),
    importeOc: redondea(x.importeOc),
    unidades: Math.round(x.unidades * 10000) / 10000,
    articulos: partes.size,
  }));
  if (orden) {
    return orden
      .map((k) => lista.find((x) => x.clave === k))
      .filter((x): x is Grupo => !!x);
  }
  return lista.sort(
    (a, b) => b.importe - a.importe || a.clave.localeCompare(b.clave),
  );
}

export function resumir(
  filas: FilaExistencia[],
  fechaCorte: string,
  mayores = 10,
): Resumen {
  const porArticulo = new Map<string, ArticuloMayor>();
  for (const f of filas) {
    const a = porArticulo.get(f.parte) ?? {
      parte: f.parte,
      descripcion: f.descripcion,
      importe: 0,
      importeOc: 0,
      cantidad: 0,
      unidad: f.unidad,
    };
    a.importe += f.importePesos ?? 0;
    a.importeOc += f.importePesosOc ?? 0;
    a.cantidad += f.cantidad;
    porArticulo.set(f.parte, a);
  }
  const articulos = [...porArticulo.values()].map((a) => ({
    ...a,
    importe: redondea(a.importe),
    importeOc: redondea(a.importeOc),
    cantidad: Math.round(a.cantidad * 10000) / 10000,
  }));
  return {
    clasificacion: agrupar(
      filas,
      (f) => nivelesClasificacion(f.clasificacion)[0] ?? SIN_CLASIFICACION,
    ),
    subclasificacion: agrupar(filas, (f) => {
      const n = nivelesClasificacion(f.clasificacion);
      return n.length ? n.slice(0, 2).join(' / ') : SIN_CLASIFICACION;
    }),
    antiguedad: agrupar(
      filas,
      (f) => tramoAntiguedad(f.fechaEntrada, fechaCorte),
      TRAMOS_ANTIGUEDAD,
    ),
    moneda: agrupar(filas, (f) => f.moneda ?? SIN_COSTO),
    origen: agrupar(filas, (f) => f.origen),
    mayores: [...articulos]
      .sort((a, b) => b.importe - a.importe || a.parte.localeCompare(b.parte))
      .slice(0, mayores),
    mayoresOc: [...articulos]
      .sort(
        (a, b) => b.importeOc - a.importeOc || a.parte.localeCompare(b.parte),
      )
      .slice(0, mayores),
  };
}
