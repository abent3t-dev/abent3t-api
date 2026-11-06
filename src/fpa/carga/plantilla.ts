/**
 * FP&A (bloque C, C3) — lectura de la plantilla de David (F2/B27, "Control
 * Presupuestal") para cargar el presupuesto 2027.
 *
 * Lógica pura sobre una hoja abstracta (valor guardado y fórmula de cada
 * celda), sin Excel ni base: scripts/fpa-b27-leer.ts la alimenta con SheetJS.
 * Las reglas salen de documentation/fpa/NOTAS_IMPORTADOR.md:
 *   - el bloque 2027 se encuentra por sus encabezados (12 meses y FY) y su
 *     marca "2027", no por columnas fijas (R:AC, S:AD o T:AE según el archivo);
 *   - el árbol sale de las fórmulas de suma (SUM(…), +A1+A2): una fila que
 *     suma otras es categoría, clasificación, grupo o área; las demás son
 *     líneas. Se usan todas las columnas de meses para el árbol (en Comercial
 *     la fila 35 solo suma la 37 en 2026) y las de 2027 para los montos;
 *   - no se importan subtotales ni totales (regla 13): se recalculan y lo que
 *     no cuadre con el archivo se explica fila por fila;
 *   - las fórmulas con el tipo de cambio o la inflación se descomponen (regla
 *     3): `=140000*19` es USD 140,000 y `=50000*$T$2` es 50,000 con índice
 *     inflación; lo demás entra en pesos con precio acordado;
 *   - un monto repartido (`=1000000/12`) se redondea a centavos y el último
 *     mes absorbe la diferencia, como "repartir un total" del diseño;
 *   - Facturado, Provisión y "Proveedores facturas pendientes de recibir"
 *     pasan a la línea de arriba (regla 5).
 *
 * Las pruebas están en plantilla.spec.ts.
 */
import { Prisma } from '@prisma/client';
import { calcLine } from '../fpa-calc';
import { DEPARTAMENTO_DEL_BENEFICIARIO, quitarBeneficiario } from './coa';
import { clave, limpiar } from './normalizar';

// ---------------------------------------------------------------------------
// Hoja abstracta
// ---------------------------------------------------------------------------

export interface CeldaHoja {
  /** Valor guardado por Excel (resultado de la fórmula, si la hay). */
  v?: number | string | boolean | null;
  /** Fórmula, con o sin "=". */
  f?: string | null;
}

export interface HojaPlantilla {
  nombre: string;
  maxFila: number;
  maxCol: number;
  /** Fila y columna desde 1. */
  celda(fila: number, col: number): CeldaHoja | undefined;
  oculta(fila: number): boolean;
}

export const letraColumna = (col: number): string => {
  let s = '';
  let n = col;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

const numeroColumna = (letras: string): number =>
  letras.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** "01 Enero", "Enero" o "ene" › 1; si no es un mes, 0. */
function mesDe(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const k = clave(v).replace(/^\d+\s*/, '');
  const i = MESES.findIndex(
    (m) => k === m || (k.length >= 3 && m.startsWith(k)),
  );
  return i + 1;
}

const formulaDe = (c: CeldaHoja | undefined): string | null => {
  const f = c?.f;
  if (!f) return null;
  return f.startsWith('=') ? f.slice(1) : f;
};

// Sin prefijo de hoja: las fórmulas con "!" se descartan antes (un prefijo
// opcional se comería la primera letra de AA27 y la leería como A27)
const REF = /\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/g;

/**
 * Filas que suma una fórmula de pura suma en la misma columna (`SUM(T9:T12)`,
 * `+T8+T13`), o null si no es pura suma (constantes, productos, otras hojas,
 * otras columnas).
 */
export function filasSumadas(formula: string, col: number): number[] | null {
  const f = formula.replace(/\s+/g, '').replace(/^=/, '');
  if (f.includes('!')) return null;
  const sinRefs = f
    .replace(/SUM\(/gi, '(')
    .replace(/\$?[A-Z]{1,3}\$?\d+(:\$?[A-Z]{1,3}\$?\d+)?/g, 'R');
  if (!/^[+(),R]*$/.test(sinRefs) || !sinRefs.includes('R')) return null;
  const filas: number[] = [];
  for (const m of f.matchAll(REF)) {
    const c1 = numeroColumna(m[1]);
    const r1 = Number(m[2]);
    const c2 = m[3] ? numeroColumna(m[3]) : c1;
    const r2 = m[4] ? Number(m[4]) : r1;
    if (c1 !== col || c2 !== col) return null;
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) filas.push(r);
  }
  return filas;
}

// ---------------------------------------------------------------------------
// Lectura de la hoja: encabezado, bloque 2027, filas y árbol
// ---------------------------------------------------------------------------

export interface FilaLeida {
  fila: number;
  etiqueta: string | null;
  oculta: boolean;
  prioridad: string | null;
  comentario: string | null;
  /** Valor guardado de cada mes de 2027 (null = vacío o no numérico). */
  meses: Array<number | null>;
  formulas: Array<string | null>;
  /** Texto en una celda de monto (p. ej. "-"). */
  textos: Array<string | null>;
  /** La celda tiene fórmula pero Excel no guardó su valor. */
  sinValor: boolean[];
  fy: number | null;
  hijos: number[];
  padre: number | null;
  /** Meses de 2027 en los que una fila que suma trae su propio monto. */
  propios: boolean[];
}

export interface HojaLeida {
  hoja: string;
  encabezado: number;
  columnas2027: number[];
  columnaFY: number | null;
  columnaEtiqueta: number;
  columnaPrioridad: number | null;
  columnaComentarios: number | null;
  inflacion: { pct: number; factor: number; celdas: string[] } | null;
  filas: Map<number, FilaLeida>;
  raices: number[];
  avisos: string[];
}

function bloquesDeMeses(hoja: HojaPlantilla, fila: number): number[] {
  const inicios: number[] = [];
  for (let c = 1; c + 11 <= hoja.maxCol; c++) {
    if (mesDe(hoja.celda(fila, c)?.v) !== 1) continue;
    let ok = true;
    for (let m = 2; m <= 12 && ok; m++) {
      ok = mesDe(hoja.celda(fila, c + m - 1)?.v) === m;
    }
    if (ok) inicios.push(c);
  }
  return inicios;
}

const esTotal = (etiqueta: string) =>
  ['total', 'total general'].includes(clave(etiqueta));

const esMarca2027 = (v: unknown) =>
  v === 2027 ||
  (typeof v === 'string' && (/2027/.test(v) || /\bB-?27\b/i.test(v)));

/** Lee la hoja: dónde está cada cosa, las filas con datos y su árbol. */
export function leerHoja(hoja: HojaPlantilla): HojaLeida {
  const avisos: string[] = [];
  let encabezado = 0;
  let bloques: number[] = [];
  for (let r = 1; r <= Math.min(30, hoja.maxFila); r++) {
    const b = bloquesDeMeses(hoja, r);
    if (b.length > 0) {
      encabezado = r;
      bloques = b;
      break;
    }
  }
  if (!encabezado) {
    throw new Error(
      `${hoja.nombre}: no encontré los encabezados de los meses (01 Enero … 12 Diciembre)`,
    );
  }
  const con2027 = bloques.filter((c) =>
    [1, 2, 3].some(
      (d) =>
        encabezado - d >= 1 && esMarca2027(hoja.celda(encabezado - d, c)?.v),
    ),
  );
  let inicio: number;
  if (con2027.length === 1) inicio = con2027[0];
  else if (con2027.length === 0 && bloques.length === 1) {
    inicio = bloques[0];
    avisos.push(
      `${hoja.nombre}: un solo bloque de meses sin la marca 2027; se toma como 2027`,
    );
  } else {
    throw new Error(
      `${hoja.nombre}: ${con2027.length === 0 ? 'ningún bloque de meses dice 2027' : 'varios bloques dicen 2027'} (fila ${encabezado})`,
    );
  }
  const columnas2027 = Array.from({ length: 12 }, (_, i) => inicio + i);
  const fyTexto = hoja.celda(encabezado, inicio + 12)?.v;
  const columnaFY =
    typeof fyTexto === 'string' &&
    ['fy', 'total', 'anual'].includes(clave(fyTexto))
      ? inicio + 12
      : null;

  // Columna de la etiqueta: la de "Gastos"; si no, la que más texto trae
  const primerBloque = Math.min(...bloques);
  let columnaEtiqueta = 0;
  for (let c = 1; c < primerBloque; c++) {
    const v = hoja.celda(encabezado, c)?.v;
    if (typeof v === 'string' && ['gastos', 'expenses'].includes(clave(v)))
      columnaEtiqueta = c;
  }
  if (!columnaEtiqueta) {
    let mejor = 0;
    for (let c = 1; c < primerBloque; c++) {
      let n = 0;
      for (let r = encabezado + 1; r <= hoja.maxFila; r++) {
        if (typeof hoja.celda(r, c)?.v === 'string') n++;
      }
      if (n > mejor) {
        mejor = n;
        columnaEtiqueta = c;
      }
    }
  }
  if (!columnaEtiqueta)
    throw new Error(`${hoja.nombre}: no encontré la columna de los conceptos`);

  const esPrioridad = (v: unknown) =>
    typeof v === 'string' &&
    /^(contractual|necesario|deseable)/i.test(v.trim());
  let columnaPrioridad: number | null = null;
  for (let c = 1; c < columnaEtiqueta && columnaPrioridad === null; c++) {
    for (let r = encabezado + 1; r <= hoja.maxFila; r++) {
      if (esPrioridad(hoja.celda(r, c)?.v)) {
        columnaPrioridad = c;
        break;
      }
    }
  }
  let columnaComentarios: number | null = null;
  for (let c = (columnaFY ?? inicio + 11) + 1; c <= hoja.maxCol; c++) {
    const v = hoja.celda(encabezado, c)?.v;
    if (typeof v === 'string' && /coment/i.test(v)) columnaComentarios = c;
  }

  // Inflación: "Inflación 3.7" y, junto, la celda con el factor (1.037)
  let inflacion: HojaLeida['inflacion'] = null;
  for (let r = 1; r < encabezado && !inflacion; r++) {
    for (let c = 1; c <= hoja.maxCol && !inflacion; c++) {
      const v = hoja.celda(r, c)?.v;
      const m =
        typeof v === 'string'
          ? /inflaci[oó]n\s*:?\s*([\d.,]+)\s*%?/i.exec(v)
          : null;
      if (!m) continue;
      const pct = Number(m[1].replace(',', '.'));
      const factor = Math.round((1 + pct / 100) * 1e6) / 1e6;
      const celdas: string[] = [];
      for (const [rr, cc] of [
        [r, c + 1],
        [r, c + 2],
        [r + 1, c],
        [r + 1, c + 1],
      ]) {
        const n = hoja.celda(rr, cc)?.v;
        if (typeof n === 'number' && Math.abs(n - factor) < 1e-9) {
          celdas.push(`${letraColumna(cc)}${rr}`);
        }
      }
      inflacion = { pct, factor, celdas };
    }
  }

  // Filas con datos
  const todasLasColumnas = bloques.flatMap((b) =>
    Array.from({ length: 12 }, (_, i) => b + i),
  );
  const filas = new Map<number, FilaLeida>();
  for (let r = encabezado + 1; r <= hoja.maxFila; r++) {
    const ve = hoja.celda(r, columnaEtiqueta)?.v;
    const etiqueta = typeof ve === 'string' && limpiar(ve) ? limpiar(ve) : null;
    const meses: Array<number | null> = [];
    const formulas: Array<string | null> = [];
    const textos: Array<string | null> = [];
    const sinValor: boolean[] = [];
    for (const c of columnas2027) {
      const celda = hoja.celda(r, c);
      const f = formulaDe(celda);
      const v = celda?.v;
      formulas.push(f);
      meses.push(typeof v === 'number' ? v : null);
      textos.push(typeof v === 'string' && v.trim() ? v.trim() : null);
      sinValor.push(!!f && (v === undefined || v === null));
    }
    const hijos = new Set<number>();
    for (const c of todasLasColumnas) {
      const f = formulaDe(hoja.celda(r, c));
      const sumadas = f ? filasSumadas(f, c) : null;
      for (const h of sumadas ?? []) {
        if (h > encabezado && h !== r) hijos.add(h);
      }
    }
    const conDatos =
      meses.some((m) => m !== null && m !== 0) ||
      textos.some(Boolean) ||
      sinValor.some(Boolean);
    if (!etiqueta && !conDatos && hijos.size === 0) continue;
    const fyv = columnaFY ? hoja.celda(r, columnaFY)?.v : null;
    const pv = columnaPrioridad ? hoja.celda(r, columnaPrioridad)?.v : null;
    const cv = columnaComentarios ? hoja.celda(r, columnaComentarios)?.v : null;
    filas.set(r, {
      fila: r,
      etiqueta,
      oculta: hoja.oculta(r),
      prioridad: typeof pv === 'string' ? limpiar(pv) : null,
      comentario: typeof cv === 'string' && limpiar(cv) ? limpiar(cv) : null,
      meses,
      formulas,
      textos,
      sinValor,
      fy: typeof fyv === 'number' ? fyv : null,
      hijos: [...hijos].sort((a, b) => a - b),
      padre: null,
      propios: columnas2027.map((c, i) => {
        if (hijos.size === 0) return false;
        const f = formulas[i];
        return !f || filasSumadas(f, c) === null;
      }),
    });
  }
  // Padre: la fila que la suma con menos hijos (la más cercana). Un "Total"
  // al final (Legal, Medición, Planta) solo repite las áreas: no es padre
  for (const p of filas.values()) {
    if (p.etiqueta && esTotal(p.etiqueta)) continue;
    for (const h of p.hijos) {
      const hijo = filas.get(h);
      if (!hijo) continue;
      const actual = hijo.padre ? filas.get(hijo.padre) : null;
      if (!actual || p.hijos.length < actual.hijos.length) hijo.padre = p.fila;
    }
  }
  const raices = [...filas.values()]
    .filter((f) => f.padre === null)
    .map((f) => f.fila);
  return {
    hoja: hoja.nombre,
    encabezado,
    columnas2027,
    columnaFY,
    columnaEtiqueta,
    columnaPrioridad,
    columnaComentarios,
    inflacion,
    filas,
    raices,
    avisos,
  };
}

// ---------------------------------------------------------------------------
// Catálogo: de las etiquetas del archivo a categoría y clasificación
// ---------------------------------------------------------------------------

export interface ContextoCatalogo {
  /** Catálogo completo (COA más las de la plataforma, como Viajes › Viajes). */
  categorias: Array<{ nombre: string; clasificaciones: string[] }>;
  /** Por departamento: las parejas [categoría, clasificación] del COA. */
  pares: Record<string, Array<[string, string]>>;
}

/** Secciones del archivo › área de FP&A y su departamento propio. */
export const SECCIONES: Record<string, { area: string; departamento: string }> =
  {
    [clave('RRHH')]: {
      area: 'Recursos Humanos',
      departamento: 'Recursos Humanos',
    },
    [clave('Recursos Humanos')]: {
      area: 'Recursos Humanos',
      departamento: 'Recursos Humanos',
    },
    [clave('Servicios Generales')]: {
      area: 'Servicios Generales',
      departamento: 'Servicios Generales',
    },
    [clave('SSGG')]: {
      area: 'Servicios Generales',
      departamento: 'Servicios Generales',
    },
    [clave('IT')]: { area: 'TI', departamento: 'IT' },
    [clave('TI')]: { area: 'TI', departamento: 'IT' },
    [clave('Naes')]: { area: 'NAES', departamento: 'NAES' },
    [clave('Costos GE')]: { area: 'GE', departamento: 'GE' },
    [clave('GE')]: { area: 'GE', departamento: 'GE' },
    [clave('Operación')]: { area: 'Operación', departamento: 'Operación' },
    [clave('Planta')]: { area: 'Planta', departamento: 'Planta' },
    [clave('Compras')]: { area: 'Compras', departamento: 'Compras' },
    [clave('Comercial')]: { area: 'Comercial', departamento: 'Comercial' },
    [clave('Medición')]: { area: 'Medición', departamento: 'Medición' },
    [clave('Legal')]: { area: 'Legal', departamento: 'Legal' },
    [clave('Dirección General')]: {
      area: 'Dirección General',
      departamento: 'Dirección General',
    },
    [clave('DG')]: {
      area: 'Dirección General',
      departamento: 'Dirección General',
    },
    [clave('Finanzas')]: { area: 'Finanzas', departamento: 'Finanzas' },
  };

/** Supuestos para decidir con Laura: nombres del archivo que no son del COA. */
export const ALIAS_CATEGORIA: Record<string, string> = {
  // Planta F2/B27, 2026-2027!B317: en el COA es "Gastos Generales Planta"
  [clave('Gastos Generales')]: 'Gastos Generales Planta',
  // Planta F2/B27, 2026-2027!B311: el COA de Planta no la tiene (es de Operación)
  [clave('Certificacion de Controles Volumetricos')]: 'Controles Volumétricos',
};

export const ALIAS_CLASIFICACION: Record<string, Record<string, string>> = {
  // El vuelo va dentro de Transporte en Compras y Comercial (FPA.md, punto 4)
  [clave('Viajes')]: {
    [clave('Vuelo')]: 'Transporte',
    [clave('Uber')]: 'Transporte',
  },
  // "Medidores" en 2026 y "Mantenimiento Medidores" en el F2/B27
  [clave('Instalaciones Técnicas')]: {
    [clave('Mantenimiento Medidores')]: 'Medidores',
  },
  [clave('Beneficios')]: { [clave('Comida Trabajadores')]: 'Comida Empleados' },
  // RH F2/B27, Detailed!B20: la provisión de NIF D-3 es el Pasivo Laboral del COA
  [clave('Salarios')]: {
    [clave('Provision Pasivo Laboral D-3')]: 'Pasivo Laboral',
  },
  // RH F2/B27, Detailed!B270: el ajuste D-5 va con la renta de la fila de arriba
  [clave('Arrendamientos')]: {
    [clave('Equipo de Cómputo D-5')]: 'Renta de Equipo de Cómputo',
  },
};

export const POR_CLASIFICAR = 'Por clasificar';

export type ComoSeMapeo =
  | 'coa'
  | 'beneficiario'
  | 'alias'
  | 'fuera_del_coa'
  | 'por_omision'
  | 'por_clasificar';

export interface Mapeo {
  categoria: string;
  clasificacion: string;
  departamento: string;
  como: ComoSeMapeo;
  nota: string | null;
}

/**
 * Categoría y clasificación de una línea a partir de su camino en el archivo
 * ([la línea, su padre, …], sin el área). La categoría es la etiqueta más
 * cercana al área que sea categoría (primero las del COA del departamento);
 * la clasificación, la más cercana a la línea. Lo que no se encuentra va a
 * "Por clasificar", para decidirlo con Laura (no se inventa).
 */
export function mapearLinea(
  camino: string[],
  departamento: string,
  ctx: ContextoCatalogo,
): Mapeo {
  const pares = ctx.pares[departamento] ?? [];
  const catDelDepto = (k: string) =>
    pares.find(([c]) => clave(c) === k)?.[0] ?? null;
  const catGlobal = (k: string) =>
    ctx.categorias.find((c) => clave(c.nombre) === k)?.nombre ?? null;

  let categoria: string | null = null;
  let indiceCat = -1;
  let fueraDelCoa = false;
  let porAlias = false;
  // Primero las del COA del departamento, de la más alta a la más baja
  for (let i = camino.length - 1; i >= 0 && !categoria; i--) {
    const c = catDelDepto(clave(camino[i]));
    if (c) [categoria, indiceCat] = [c, i];
  }
  for (let i = camino.length - 1; i >= 0 && !categoria; i--) {
    const k = clave(camino[i]);
    const alias = ALIAS_CATEGORIA[k];
    const c = alias ? catGlobal(clave(alias)) : catGlobal(k);
    if (c) {
      [categoria, indiceCat] = [c, i];
      porAlias = !!alias;
      fueraDelCoa = !catDelDepto(clave(c));
    }
  }
  if (!categoria) {
    return {
      categoria: POR_CLASIFICAR,
      clasificacion: POR_CLASIFICAR,
      departamento,
      como: 'por_clasificar',
      nota: `sin categoría del COA: ${[...camino].reverse().join(' › ')}`,
    };
  }
  const kc = clave(categoria);
  const delDepto = pares.filter(([c]) => clave(c) === kc).map(([, k]) => k);
  const global =
    ctx.categorias.find((c) => clave(c.nombre) === kc)?.clasificaciones ?? [];
  const buscar = (k: string): { nombre: string; enDepto: boolean } | null => {
    const d = delDepto.find((x) => clave(x) === k);
    if (d) return { nombre: d, enDepto: true };
    const g = global.find((x) => clave(x) === k);
    return g ? { nombre: g, enDepto: false } : null;
  };
  // El alias de la categoría ("Gastos Generales") se anota en la línea, pero
  // si la pareja final es del COA del departamento, la línea es del COA
  const notaCategoria = porAlias
    ? `"${camino[indiceCat]}" se tomó como la categoría ${categoria}`
    : null;
  const resultado = (
    clasificacion: { nombre: string; enDepto: boolean },
    como: ComoSeMapeo,
    nota: string | null,
    depto = departamento,
  ): Mapeo => {
    const delCoa = clasificacion.enDepto && !fueraDelCoa;
    return {
      categoria: categoria,
      clasificacion: clasificacion.nombre,
      departamento: depto,
      como: delCoa ? como : 'fuera_del_coa',
      nota:
        [
          notaCategoria,
          nota,
          delCoa
            ? null
            : `${categoria} › ${clasificacion.nombre} no está en el COA de ${departamento}`,
        ]
          .filter(Boolean)
          .join('; ') || null,
    };
  };

  for (let i = 0; i < indiceCat; i++) {
    const etiqueta = camino[i];
    const k = clave(etiqueta);
    const exacta = buscar(k);
    if (exacta?.enDepto || (exacta && !pares.some(([, x]) => clave(x) === k))) {
      return resultado(exacta, 'coa', null);
    }
    // En otra categoría del COA del departamento (Planta tiene "Otras
    // Comunicaciones" como categoría; el archivo la pone dentro de Comunicaciones)
    const otraCategoria = pares.find(([, x]) => clave(x) === k);
    if (otraCategoria) {
      return {
        categoria: otraCategoria[0],
        clasificacion: otraCategoria[1],
        departamento,
        como: 'coa',
        nota: `en el archivo va dentro de ${categoria}`,
      };
    }
    const alias = ALIAS_CLASIFICACION[kc]?.[k];
    const porAliasCls = alias ? buscar(clave(alias)) : null;
    if (porAliasCls) {
      return resultado(
        porAliasCls,
        'alias',
        `"${etiqueta}" se cargó como ${categoria} › ${porAliasCls.nombre}`,
      );
    }
    // "Autos Dirección General": Autos, cargado al departamento Dirección General
    const sinBenef = quitarBeneficiario(categoria, etiqueta);
    if (sinBenef.beneficiario) {
      const b = buscar(clave(sinBenef.clasificacion));
      const depto = DEPARTAMENTO_DEL_BENEFICIARIO[sinBenef.beneficiario];
      if (b) {
        return resultado(
          b,
          'beneficiario',
          depto
            ? null
            : `${sinBenef.beneficiario} no es un departamento de FP&A; se carga a ${departamento}`,
          depto ?? departamento,
        );
      }
    }
    // "Renta de Equipo de Computo HEWLETT PACKARD…" empieza con su clasificación
    const prefijo = [...delDepto, ...global].find(
      (x) => clave(x).split(' ').length >= 2 && k.startsWith(`${clave(x)} `),
    );
    if (prefijo)
      return resultado(
        { nombre: prefijo, enDepto: delDepto.includes(prefijo) },
        'coa',
        null,
      );
  }
  // Sin clasificación en el camino: la del mismo nombre o la única del departamento
  const mismaQueCategoria = buscar(kc);
  const unica =
    delDepto.length === 1 ? { nombre: delDepto[0], enDepto: true } : null;
  const porOmision = mismaQueCategoria ?? unica;
  if (porOmision) return resultado(porOmision, 'por_omision', null);
  return {
    categoria,
    clasificacion: POR_CLASIFICAR,
    departamento,
    como: 'por_clasificar',
    nota: [
      notaCategoria,
      `"${camino[0]}" no es una clasificación de ${categoria}`,
    ]
      .filter(Boolean)
      .join('; '),
  };
}

// ---------------------------------------------------------------------------
// Montos: descomponer el tipo de cambio y la inflación
// ---------------------------------------------------------------------------

export interface ParametrosArchivo {
  inflacion: { pct: number; factor: number; celdas: string[] } | null;
  /** Pesos por dólar de las fórmulas del 2027 (p. ej. 19), o null. */
  usd: number | null;
}

export interface MontosLinea {
  moneda: 'MXN' | 'USD';
  indice: 'precio_acordado' | 'inflacion';
  /** Monto capturado por mes (en su moneda, sin inflación), con 2 decimales. */
  meses: Array<{ mes: number; monto: string }>;
  nota: string | null;
}

const centavos = (n: number) => Math.round(n * 100);
const deCentavos = (c: number) => (c / 100).toFixed(2);

const multiplicaPor = (formula: string, valor: number) =>
  new RegExp(
    `(^|[^\\d.$A-Z])${String(valor).replace('.', '\\.')}(\\.0+)?\\s*\\*|\\*\\s*${String(valor).replace('.', '\\.')}(\\.0+)?(?![\\d.])`,
  ).test(formula.replace(/\s+/g, ''));

const usaCelda = (formula: string, celdas: string[]) =>
  celdas.some((c) => {
    const m = /^([A-Z]+)(\d+)$/.exec(c);
    return m
      ? new RegExp(`\\$?${m[1]}\\$?${m[2]}(?!\\d)`).test(formula)
      : false;
  });

/**
 * Montos de una línea a partir de los valores guardados de 2027 y sus
 * fórmulas. Si todos los meses con monto son `x*19`, va en USD; si todos
 * multiplican por la inflación, va con índice inflación; si no, en pesos.
 */
export function montosDeLinea(
  meses: Array<number | null>,
  formulas: Array<string | null>,
  params: ParametrosArchivo,
): MontosLinea {
  const conMonto = meses
    .map((v, i) => ({ v, f: formulas[i], mes: i + 1 }))
    .filter(
      (x): x is { v: number; f: string | null; mes: number } =>
        x.v !== null && x.v !== 0,
    );
  const tipo = (x: { f: string | null }) => {
    if (!x.f) return 'mxn';
    if (params.usd && multiplicaPor(x.f, params.usd)) return 'usd';
    if (
      params.inflacion &&
      (usaCelda(x.f, params.inflacion.celdas) ||
        multiplicaPor(x.f, params.inflacion.factor))
    ) {
      return 'inflacion';
    }
    return 'mxn';
  };
  const tipos = new Set(conMonto.map(tipo));
  const pesos = (nota: string | null): MontosLinea => {
    const cs = conMonto.map((x) => centavos(x.v));
    const objetivo = centavos(conMonto.reduce((s, x) => s + x.v, 0));
    const diferencia = objetivo - cs.reduce((s, c) => s + c, 0);
    // Repartir un total: el último mes absorbe los centavos
    if (
      cs.length > 0 &&
      diferencia !== 0 &&
      Math.abs(diferencia) <= cs.length
    ) {
      cs[cs.length - 1] += diferencia;
    }
    return {
      moneda: 'MXN',
      indice: 'precio_acordado',
      meses: conMonto.map((x, i) => ({ mes: x.mes, monto: deCentavos(cs[i]) })),
      nota,
    };
  };
  if (tipos.size > 1)
    return pesos('mezcla de fórmulas en el año: se carga el monto en pesos');
  const unico = [...tipos][0];
  if (unico === 'usd' && params.usd) {
    const usd = params.usd;
    const base = conMonto.map((x) => centavos(x.v / usd));
    const exacto = conMonto.every(
      (x, i) => Math.abs((base[i] / 100) * usd - x.v) <= 0.005,
    );
    if (exacto) {
      return {
        moneda: 'USD',
        indice: 'precio_acordado',
        meses: conMonto.map((x, i) => ({
          mes: x.mes,
          monto: deCentavos(base[i]),
        })),
        nota: null,
      };
    }
    return pesos(
      'el monto en dólares no da centavos exactos: se carga en pesos',
    );
  }
  if (unico === 'inflacion' && params.inflacion) {
    const factor = params.inflacion.factor;
    const base = conMonto.map((x) => centavos(x.v / factor));
    const exacto = conMonto.every(
      (x, i) =>
        Math.abs(centavos((base[i] / 100) * factor) - centavos(x.v)) <= 0,
    );
    if (exacto) {
      return {
        moneda: 'MXN',
        indice: 'inflacion',
        meses: conMonto.map((x, i) => ({
          mes: x.mes,
          monto: deCentavos(base[i]),
        })),
        nota: null,
      };
    }
    return pesos(
      'la base sin inflación no da centavos exactos: se carga el monto inflado',
    );
  }
  return pesos(null);
}

/** Total en pesos de una línea con fpa-calc (lo mismo que hará la plataforma). */
export function totalEnPesos(
  m: MontosLinea,
  params: { inflacion_pct: string | null; usd: string | null },
): { total: string | null; meses: Array<string | null> } {
  const r = calcLine(
    {
      calc_method: 'monto_mes',
      currency: m.moneda,
      price_index: m.indice,
      months: m.meses.map((x) => ({ month: x.mes, amount: x.monto })),
    },
    {
      inflation_pct: params.inflacion_pct,
      cutoff_month: null,
      rates: params.usd ? { USD: params.usd } : {},
      travel_rates: [],
    },
  );
  return {
    total: r.total_mxn ? r.total_mxn.toFixed(2) : null,
    meses: r.months.map((x) => (x.amount_mxn ? x.amount_mxn.toFixed(2) : null)),
  };
}

// ---------------------------------------------------------------------------
// Líneas de cada área
// ---------------------------------------------------------------------------

// "Facturado" y "Provisión" tal cual (no "Provision Pasivo Laboral D-3")
const esFilaDelReal = (etiqueta: string | null) =>
  !!etiqueta &&
  ([clave('Facturado'), clave('Provisión')].includes(clave(etiqueta)) ||
    clave(etiqueta).startsWith(
      clave('Proveedores facturas pendientes de recibir'),
    ));

const PRIORIDADES: Array<[RegExp, string]> = [
  [/^contractual/i, 'contractual'],
  [/^necesario/i, 'necesario'],
  [/^deseable/i, 'deseable'],
];
const prioridadDe = (texto: string | null): string | null =>
  texto ? (PRIORIDADES.find(([re]) => re.test(texto))?.[1] ?? null) : null;

export interface LineaB27 {
  ref: string;
  fila: number;
  concepto: string;
  /** Texto para buscar el proveedor en el catálogo de SAP al cargar. */
  proveedor: string;
  categoria: string;
  clasificacion: string;
  departamento: string;
  como: ComoSeMapeo;
  prioridad: string | null;
  moneda: 'MXN' | 'USD';
  indice: 'precio_acordado' | 'inflacion';
  meses: Array<{ mes: number; monto: string }>;
  /** Total en pesos con fpa-calc. */
  total: string;
  justificacion: string | null;
  notas: string[];
}

export interface DiferenciaB27 {
  area: string;
  fila: number;
  etiqueta: string;
  archivo: string;
  lineas: string;
  diferencia: string;
  motivo: string;
}

export interface SeccionB27 {
  area: string;
  departamento: string;
  fila: number;
  etiqueta: string;
  /** Lo que dice la fila del área en el archivo (FY de 2027). */
  total_archivo: string;
  /** Suma de las líneas con fpa-calc. */
  total_lineas: string;
  /** líneas − archivo. */
  diferencia: string;
  /**
   * ninguna; redondeo (centavos de redondear cada mes); explicada (las filas
   * del archivo que no suman todo, en `diferencias`); sin_explicar.
   */
  tipo_diferencia: 'ninguna' | 'redondeo' | 'explicada' | 'sin_explicar';
  lineas: LineaB27[];
}

export interface ArchivoB27 {
  archivo: string;
  hoja: string;
  secciones: SeccionB27[];
  diferencias: DiferenciaB27[];
  avisos: string[];
  problemas: string[];
}

const suma = (xs: Array<number | null>) =>
  xs.reduce<number>((s, x) => s + (x ?? 0), 0);
const dinero = (n: number) => n.toFixed(2);

/**
 * Las líneas de 2027 de cada área de una hoja ya leída, con su categoría,
 * clasificación y montos, y lo que no cuadra con el archivo.
 */
export function lineasDeHoja(
  leida: HojaLeida,
  archivo: string,
  corto: string,
  params: ParametrosArchivo,
  ctx: ContextoCatalogo,
): ArchivoB27 {
  const avisos = [...leida.avisos];
  const problemas: string[] = [];
  const diferencias: DiferenciaB27[] = [];
  const secciones: SeccionB27[] = [];
  const paramsCalc = {
    inflacion_pct: params.inflacion ? params.inflacion.pct.toFixed(3) : null,
    usd: params.usd ? String(params.usd) : null,
  };
  const fila = (n: number) => leida.filas.get(n);
  const celda = (n: number, mes: number) =>
    `${letraColumna(leida.columnas2027[mes])}${n}`;

  for (const raiz of leida.raices) {
    const r = fila(raiz);
    if (!r) continue;
    if (r.etiqueta && esTotal(r.etiqueta)) continue;
    const total2027 = suma(r.meses);
    const destino = r.etiqueta ? SECCIONES[clave(r.etiqueta)] : undefined;
    if (!destino) {
      const huerfana = r.hijos.length === 0 && total2027 !== 0;
      if (huerfana) {
        problemas.push(
          `${leida.hoja}!${r.fila} "${r.etiqueta ?? '(sin concepto)'}": trae 2027 (${dinero(total2027)}) y no está dentro de ningún área`,
        );
      } else if (total2027 !== 0) {
        avisos.push(
          `${leida.hoja}!${r.fila} "${r.etiqueta ?? '(sin concepto)'}" no es un área conocida; se ignora (2027 = ${dinero(total2027)})`,
        );
      }
      continue;
    }
    if (r.oculta) {
      if (total2027 !== 0) {
        avisos.push(
          `${leida.hoja}!${r.fila} ${r.etiqueta}: el área está oculta; no se carga (2027 = ${dinero(total2027)})`,
        );
      }
      continue;
    }

    const lineas: LineaB27[] = [];
    const visitar = (n: number, camino: FilaLeida[]) => {
      const f = fila(n);
      if (!f) return;
      const nuevoCamino = [...camino, f];
      const conMontoPropio =
        f.hijos.length === 0 ||
        f.propios.some((p, i) => p && (f.meses[i] ?? 0) !== 0);
      if (conMontoPropio) {
        const meses =
          f.hijos.length === 0
            ? f.meses
            : f.meses.map((v, i) => (f.propios[i] ? v : null));
        const formulas =
          f.hijos.length === 0
            ? f.formulas
            : f.formulas.map((x, i) => (f.propios[i] ? x : null));
        for (let i = 0; i < 12; i++) {
          if (f.textos[i])
            problemas.push(
              `${leida.hoja}!${celda(f.fila, i)}: texto "${f.textos[i]}" donde va un monto`,
            );
          if (f.sinValor[i])
            problemas.push(
              `${leida.hoja}!${celda(f.fila, i)}: la fórmula no trae valor guardado (abrir y guardar el archivo en Excel)`,
            );
        }
        if (meses.some((v) => v !== null && v !== 0)) {
          const delReal = esFilaDelReal(f.etiqueta);
          // [la línea, su padre, …] hasta antes del área; Facturado/Provisión pasan a la de arriba
          const caminoEtiquetas = nuevoCamino
            .slice(1)
            .reverse()
            .map((x) => x.etiqueta ?? '')
            .filter((e, i) => !(i === 0 && delReal) && e);
          const mapeo = mapearLinea(caminoEtiquetas, destino.departamento, ctx);
          const montos = montosDeLinea(meses, formulas, params);
          const calculado = totalEnPesos(montos, paramsCalc);
          const concepto =
            (delReal ? caminoEtiquetas[0] : f.etiqueta) ??
            caminoEtiquetas[0] ??
            '(sin concepto)';
          const notas: string[] = [];
          if (delReal)
            notas.push(
              `en el archivo va en la fila "${f.etiqueta}" (${leida.hoja}!${f.fila})`,
            );
          if (f.hijos.length > 0)
            notas.push(
              `monto propio de una fila que suma (${leida.hoja}!${f.fila})`,
            );
          if (mapeo.nota) notas.push(mapeo.nota);
          if (montos.nota) notas.push(montos.nota);
          const prioridad =
            prioridadDe(f.prioridad) ??
            prioridadDe(
              [...nuevoCamino].reverse().find((x) => prioridadDe(x.prioridad))
                ?.prioridad ?? null,
            );
          if (!calculado.total) {
            problemas.push(
              `${leida.hoja}!${f.fila} ${concepto}: no se pudo calcular (falta un parámetro)`,
            );
          }
          // Lo que la plataforma calculará contra lo que dice el archivo, mes por mes
          // (hasta 12 centavos: el último mes absorbe los de un total repartido)
          meses.forEach((v, i) => {
            const plataforma = calculado.meses[i] ?? null;
            if (
              v !== null &&
              v !== 0 &&
              plataforma !== null &&
              Math.abs(Number(plataforma) - v) > 0.125
            ) {
              problemas.push(
                `${leida.hoja}!${celda(f.fila, i)}: el archivo dice ${dinero(v)} y se calcularía ${plataforma}`,
              );
            }
          });
          lineas.push({
            ref: `${corto}, ${leida.hoja}!${f.fila}`.slice(0, 120),
            fila: f.fila,
            concepto:
              concepto.length > 255 ? `${concepto.slice(0, 254)}…` : concepto,
            proveedor: delReal ? '' : (f.etiqueta ?? ''),
            categoria: mapeo.categoria,
            clasificacion: mapeo.clasificacion,
            departamento: mapeo.departamento,
            como: mapeo.como,
            prioridad,
            moneda: montos.moneda,
            indice: montos.indice,
            meses: montos.meses,
            total: calculado.total ?? '0.00',
            justificacion: f.comentario,
            notas,
          });
        }
      }
      for (const h of f.hijos) {
        if (fila(h)?.padre === f.fila) visitar(h, nuevoCamino);
      }
      // Lo que no cuadra: una fila que suma contra la suma de sus filas
      if (f.hijos.length > 0) {
        const hijos = f.hijos
          .map(fila)
          .filter((x): x is FilaLeida => !!x && x.padre === f.fila);
        const delArchivo = suma(f.meses);
        const deSusFilas = hijos.reduce((s, h) => s + suma(h.meses), 0);
        const propio = suma(f.meses.map((v, i) => (f.propios[i] ? v : 0)));
        if (Math.abs(delArchivo - (deSusFilas + propio)) > 0.05) {
          const motivos: string[] = [];
          const tecleadas = f.propios
            .map((p, i) =>
              p && f.formulas[i] === null ? celda(f.fila, i) : null,
            )
            .filter(Boolean);
          if (tecleadas.length)
            motivos.push(
              `celdas tecleadas en vez de suma: ${tecleadas.join(', ')}`,
            );
          const sumadasEn2027 = new Set<number>();
          f.formulas.forEach((x, i) => {
            for (const h of (x && filasSumadas(x, leida.columnas2027[i])) || [])
              sumadasEn2027.add(h);
          });
          const fuera = hijos
            .filter((h) => !sumadasEn2027.has(h.fila) && suma(h.meses) !== 0)
            .map((h) => h.fila);
          if (fuera.length)
            motivos.push(`en 2027 no suma la(s) fila(s) ${fuera.join(', ')}`);
          diferencias.push({
            area: destino.area,
            fila: f.fila,
            etiqueta: f.etiqueta ?? '(sin concepto)',
            archivo: dinero(delArchivo),
            lineas: dinero(deSusFilas + propio),
            diferencia: dinero(deSusFilas + propio - delArchivo),
            motivo:
              motivos.join('; ') ||
              'la fórmula del archivo no suma todas sus filas',
          });
        }
      }
    };
    for (const h of r.hijos) {
      if (fila(h)?.padre === r.fila) visitar(h, [r]);
    }
    const totalLineas = lineas.reduce(
      (s, l) => s.plus(l.total),
      new Prisma.Decimal(0),
    );
    const totalArchivo = new Prisma.Decimal(dinero(r.fy ?? total2027));
    const diferencia = totalLineas.minus(totalArchivo);
    // Cada mes redondeado a centavos mueve a lo más medio centavo
    const tolerancia =
      0.005 * lineas.reduce((n, l) => n + l.meses.length, 0) + 0.01;
    const explicado = diferencias
      .filter((d) => d.area === destino.area)
      .reduce((s, d) => s + Number(d.diferencia), 0);
    const tipo: SeccionB27['tipo_diferencia'] = diferencia.isZero()
      ? 'ninguna'
      : diferencia.abs().lte(tolerancia)
        ? 'redondeo'
        : Math.abs(diferencia.toNumber() - explicado) <= tolerancia
          ? 'explicada'
          : 'sin_explicar';
    if (tipo === 'sin_explicar') {
      problemas.push(
        `${destino.area}: las líneas suman ${totalLineas.toFixed(2)} y el archivo dice ${totalArchivo.toFixed(2)} (${diferencia.toFixed(2)}), sin explicación`,
      );
    }
    secciones.push({
      area: destino.area,
      departamento: destino.departamento,
      fila: r.fila,
      etiqueta: r.etiqueta ?? '',
      total_archivo: totalArchivo.toFixed(2),
      total_lineas: totalLineas.toFixed(2),
      diferencia: diferencia.toFixed(2),
      tipo_diferencia: tipo,
      lineas,
    });
  }
  return {
    archivo,
    hoja: leida.hoja,
    secciones,
    diferencias,
    avisos,
    problemas,
  };
}

/**
 * Pesos por dólar que usan las fórmulas de 2027 (`x*19`): el multiplicador
 * entero entre 15 y 25 que más aparece. null si no hay.
 */
export function dolarDeLasFormulas(leidas: HojaLeida[]): number | null {
  const cuenta = new Map<number, number>();
  for (const l of leidas) {
    for (const f of l.filas.values()) {
      for (const x of f.formulas) {
        if (!x) continue;
        for (const m of x
          .replace(/\s+/g, '')
          .matchAll(
            /(?:^|[^\d.$A-Z])(1[5-9]|2[0-5])\*|\*(1[5-9]|2[0-5])(?![\d.])/g,
          )) {
          const n = Number(m[1] ?? m[2]);
          cuenta.set(n, (cuenta.get(n) ?? 0) + 1);
        }
      }
    }
  }
  const [mejor] = [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
  return mejor ? mejor[0] : null;
}
