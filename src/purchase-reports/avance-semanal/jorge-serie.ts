/**
 * H1/K5 — Serie del "Reporte de avance semanal" que Jorge armaba a mano
 * (documentation/Reporte_Semanal_20260925.pdf y
 * Reporte_Semanal_Jorge_series_2026.csv), tal cual, con sus errores de
 * captura: la conciliación los detecta con las identidades de la propia
 * serie (avance-semanal.conciliacion.ts), sin corregirlos aquí. Montos y
 * anual transcritos de sus imágenes (TAREAS_COMPRAS_2026-09-29, H1).
 *
 * Desde el 30-sep el reporte oficial es el de la plataforma; esta serie solo
 * sirve para conciliar (endpoint de super_admin y `npm run avance:check`).
 */

const DAY_MS = 86_400_000;

/**
 * Página 1 = semana del 21-sep-2026 y cada página es la semana anterior,
 * hasta la p.38 (5-ene-2026). La p.39 es el cierre de 2025 ([657, 0, 600,
 * …]): va con el anual y no se compara al corte de una semana. Columnas:
 * recibidas del año, nuevas de la semana, cerradas del año, cerradas de la
 * semana, días de cierre (año), días de cancelación (año), y del medidor
 * del año: cerradas, canceladas, abiertas. null = vacío en su archivo.
 */
export const JORGE: Array<Array<number | null>> = [
  [582, 14, 415, 7, 11, 7, 415, 126, 41],
  [568, 16, 410, 8, 11, 7, 410, 122, 36],
  [552, 6, 402, 12, 11, 6, 402, 118, 32],
  [546, 13, 391, 20, null, 7, 391, 116, 36],
  [533, 16, 370, 17, 10, 7, 370, 110, 53],
  [517, 17, 354, 13, 10, 5, 354, 105, 58],
  [500, 11, 341, 11, 10, 5, 341, 98, 61],
  [489, 16, 330, 10, 10, 5, 330, 98, 61],
  [473, 13, 322, 9, 10, 4, 322, 90, 61],
  [460, 8, 311, 13, 10, 5, 311, 88, 61],
  [452, 24, 298, 10, 9, 5, 298, 86, 68],
  [428, 30, 287, 20, 10, 5, 287, 83, 58],
  [398, 14, 267, 6, 9, 4, 267, 80, 51],
  [384, 10, 261, 6, 9, 5, 261, 79, 44],
  [374, 9, 254, 8, 9, 5, 254, 79, 41],
  [365, 15, 243, 16, 8, 5, 243, 777, 45],
  [350, 13, 234, 6, 4, 6, 234, 74, 42],
  [337, 8, 228, 6, 8, 6, 228, 72, 37],
  [329, 9, 224, 10, 9, 6, 224, 72, 33],
  [320, 11, 216, 8, 9, 6, 216, 69, 35],
  [309, 7, 208, 5, 9, 7, 208, 69, 32],
  [302, 11, 204, 4, 9, 7, 204, 69, 29],
  [291, 15, 199, 10, 9, 7, 199, 66, 26],
  [276, 8, 189, 11, 9, 6, 189, 60, 27],
  [268, 15, 237, 10, 9, 6, 162, 54, 33],
  [249, 12, 216, 11, 9, 7, 162, 54, 33],
  [249, 12, 216, 11, 9, 7, 162, 54, 33],
  [237, 11, 203, 9, 9, 8, 149, 54, 34],
  [77, 226, 176, 4, 9, 8, 140, 52, 34],
  [77, 203, 172, 16, 9, 9, 135, 48, 20],
  [158, 199, 140, 37, 9, 9, 134, 44, 21],
  [158, 36, 120, 14, 11, 11, 92, 34, 32],
  [122, 27, 107, 20, 11, 13, 84, 23, 15],
  [95, 18, 86, 15, 11, 13, 67, 20, 8],
  [77, 15, 71, 30, 12, 16, null, null, null],
  [62, 18, 41, 15, 15, 17, null, null, null],
  [44, 21, 26, 12, 17, 23, null, null, null],
  [23, 19, 14, 14, 21, 32, null, null, null],
  [657, 0, 600, 1, 21, 32, null, null, null],
];

/** Lunes de la p.1 (semana del 21 al 25 de septiembre de 2026). */
export const JORGE_LATEST = Date.UTC(2026, 8, 21);

/** Páginas semanales (p.1 a p.38); la p.39 es el cierre de 2025. */
export const JORGE_SEMANAS = 38;

export interface JorgeSemana {
  /** 1 = semana del 21-sep-2026. */
  pagina: number;
  /** Lunes ISO de la semana. */
  lunes: string;
  recibidas: number | null;
  nuevas: number | null;
  cerradas_anio: number | null;
  cerradas_semana: number | null;
  dias_cierre: number | null;
  dias_cancelacion: number | null;
  medidor_cerradas: number | null;
  medidor_canceladas: number | null;
  medidor_abiertas: number | null;
}

function fila(pagina: number, row: Array<number | null>): JorgeSemana {
  return {
    pagina,
    lunes: new Date(JORGE_LATEST - (pagina - 1) * 7 * DAY_MS)
      .toISOString()
      .slice(0, 10),
    recibidas: row[0],
    nuevas: row[1],
    cerradas_anio: row[2],
    cerradas_semana: row[3],
    dias_cierre: row[4],
    dias_cancelacion: row[5],
    medidor_cerradas: row[6],
    medidor_canceladas: row[7],
    medidor_abiertas: row[8],
  };
}

/** Las 38 semanas de Jorge, de la más nueva (p.1) a la más vieja (p.38). */
export function jorgeSemanas(
  serie: Array<Array<number | null>> = JORGE,
): JorgeSemana[] {
  return serie.slice(0, JORGE_SEMANAS).map((row, i) => fila(i + 1, row));
}

/** P.39: cierre de 2025 (recibidas, cerradas y días del año). */
export const JORGE_CIERRE_2025 = {
  anio: 2025,
  recibidas: JORGE[JORGE_SEMANAS][0],
  cerradas: JORGE[JORGE_SEMANAS][2],
  dias_cierre: JORGE[JORGE_SEMANAS][4],
  dias_cancelacion: JORGE[JORGE_SEMANAS][5],
};

/** Fila de Jorge para la semana del `lunes` (o null si no está en su serie). */
export function jorgeFor(lunes: Date): JorgeSemana | null {
  const pagina = Math.round((JORGE_LATEST - lunes.getTime()) / (7 * DAY_MS));
  if (pagina < 0 || pagina >= JORGE_SEMANAS) return null;
  return fila(pagina + 1, JORGE[pagina]);
}

/**
 * Montos adjudicados de Jorge por mes (MXN; base a confirmar: Ingrid cree
 * que sin IVA). 2026 a septiembre (su corte del 25-sep) y 2025 completo.
 */
export const JORGE_MONTOS: Record<number, number[]> = {
  2026: [
    15_449_851.27, 10_881_397.29, 6_454_545.16, 9_391_652.55, 3_059_027.29,
    9_843_339.44, 12_387_387.45, 18_425_041.77, 8_777_856.93,
  ],
  2025: [
    9_475_086.45, 44_959_597.32, 1_924_349.55, 11_164_986.04, 13_163_686.42,
    6_066_435.34, 16_778_151.75, 33_744_871.7, 6_135_435.79, 9_226_627.74,
    59_763_881.44, 42_512_263.53,
  ],
};

/**
 * Totales que Jorge escribió. Los meses de 2025 suman 254,915,373.07 (un
 * centavo más, redondeo en su origen); la conciliación compara contra la
 * suma de los meses y muestra este aparte.
 */
export const JORGE_MONTOS_TOTAL: Record<number, number> = {
  2026: 94_670_099.15,
  2025: 254_915_373.06,
};

export interface JorgeAnio {
  anio: number;
  recibidas: number;
  /** Atendidas = cerradas + canceladas. */
  atendidas: number;
  cerradas: number | null;
  canceladas: number | null;
  /** Por qué no entra a ningún criterio (se muestra igual). */
  nota: string | null;
}

/** Barras "recibidas / atendidas" de su reporte del 25-sep. */
export const JORGE_ANUAL: JorgeAnio[] = [
  {
    anio: 2022,
    recibidas: 619,
    atendidas: 530,
    cerradas: null,
    canceladas: null,
    nota: null,
  },
  {
    anio: 2023,
    recibidas: 624,
    atendidas: 624,
    cerradas: 504,
    canceladas: 120,
    nota: null,
  },
  {
    anio: 2024,
    recibidas: 606,
    atendidas: 606,
    cerradas: 442,
    canceladas: 164,
    nota: null,
  },
  {
    anio: 2025,
    recibidas: 657,
    atendidas: 634,
    cerradas: 480,
    canceladas: 153,
    nota: 'No cuadra en su origen: 480 + 153 = 633 (no 634) y la p.39 dice 600 cerradas. Se muestra, fuera del criterio.',
  },
];
