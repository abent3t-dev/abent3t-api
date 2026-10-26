import {
  type AvanceData,
  type AvancePage,
  buildAvancePage,
  cohorteAlDia,
  firstMondayOfYear,
  isoDay,
  MESES_TITULO,
  mondayOf,
  montosAdjudicados,
  type MontosMaximo,
  parseDay,
} from './avance-semanal.engine';
import {
  AVANCE_MONTO_BASE,
  AVANCE_MONTOS_FUENTE_MAXIMO,
  AVANCE_PROMEDIO_TITULO,
  AVANCE_REGLAS,
  AVANCE_TIPO_CAMBIO,
  type AvanceCorte,
  type AvanceDiasTipo,
  type AvanceInicio,
  type AvanceMontoBase,
  type AvanceMontosFuente,
  type AvanceOpciones,
  type AvancePromedioTitulo,
  type AvanceTipoCambio,
} from './avance-semanal.reglas';
import {
  JORGE_ANUAL,
  JORGE_CIERRE_2025,
  JORGE_LATEST,
  JORGE_MONTOS,
  JORGE_MONTOS_TOTAL,
  JORGE_RQ,
  JORGE_SEMANAS,
  type JorgeRq,
  type JorgeSemana,
  jorgeSemanas,
} from './jorge-serie';

/**
 * K5.7 (2026-10-05) — Conciliación de la página de Maximo del avance
 * semanal contra la serie de Jorge, para elegir los defaults de
 * AVANCE_REGLAS en prod (dev no tiene los datos). Pura: recibe los datos ya
 * cargados con las reglas de la variante; la usan el endpoint de
 * super_admin (`GET /compras/reportes/avance-semanal/conciliacion`) y
 * `npm run avance:check` (dev).
 *
 *  - Las 38 semanas de Jorge (21-sep a 5-ene) contra nuestra página de
 *    Maximo AL CORTE DE ESA SEMANA; la p.39 (cierre de 2025) va con el
 *    anual.
 *  - Validez por página con las identidades de la propia serie, sin rangos
 *    fijos: recibidas − recibidas de la semana anterior = nuevas (primera
 *    semana del año: recibidas = nuevas); cerradas + canceladas + abiertas
 *    del medidor = recibidas; titular de cerradas = cerradas del medidor
 *    (si cuadra con cerradas + canceladas, como la p.27 y la p.28, se
 *    compara contra nuestras cerradas + canceladas). Cada KPI se compara
 *    solo donde su identidad cuadra; los que no tienen identidad (cerradas
 *    de la semana, días), donde los dos lados tienen dato.
 *  - H15 (2026-10-05): una página idéntica a la de la semana anterior en sus
 *    9 valores es copia (la p.26 repite la p.27: recibidas 249 con 12
 *    nuevas en las dos) y no se compara en ningún KPI; sus identidades
 *    internas (medidor, titular) cuadran y la dejaban pasar.
 *  - Resumen por KPI: error = Σ|nuestro − Jorge| / Σ Jorge (ponderado, para
 *    que las semanas chicas no pesen de más), error absoluto medio y sesgo
 *    (media de nuestro − Jorge).
 *  - Criterio para el default: error ≤5% en recibidas, en cerradas +
 *    canceladas y en abiertas (`cumple`), más el error absoluto medio de
 *    abiertas (con 30-60 abiertas por semana, el 5% son ±2-3 PR).
 *  - Montos MXN por mes contra Jorge, con y sin IVA y por fuente (OC de
 *    Maximo u OC de SAP migradas); anual "recibidas / atendidas".
 *  - Hipótesis de la calibración del 5-oct: H2, nuestras PR de contrato
 *    cerradas (`cerradas_de_contrato`, por semana) contra las canceladas del
 *    año de Jorge, con el mismo error que el resumen; H3 (días hábiles) no
 *    lleva cálculo aparte: se corre la variante `dias_tipo=habiles`.
 *  - O1.5 (2026-10-26): los montos con los dos tipos de cambio (Maximo del
 *    día y referencia de SAP del mes) contra el total de Jorge, con el más
 *    cercano; y las cifras de su informe de RQ del 16 y el 20-oct
 *    (`rq_octubre`) contra nuestra página de Maximo de esos días.
 *  - Los días de cierre que se comparan son los del título de la página
 *    (`cierre.titulo`, O1.3): del año o de la semana, según la regla.
 */

export type KpiConciliacion =
  | 'recibidas'
  | 'nuevas'
  | 'cerradas_anio'
  | 'cerradas_semana'
  | 'dias_cierre_promedio'
  | 'dias_cierre_mediana'
  | 'dias_cancelacion'
  | 'medidor_cerradas'
  | 'medidor_canceladas'
  | 'medidor_abiertas'
  | 'atendidas';

export const KPIS_CONCILIACION: KpiConciliacion[] = [
  'recibidas',
  'nuevas',
  'cerradas_anio',
  'cerradas_semana',
  'dias_cierre_promedio',
  'dias_cierre_mediana',
  'dias_cancelacion',
  'medidor_cerradas',
  'medidor_canceladas',
  'medidor_abiertas',
  'atendidas',
];

/** Criterio del default: recibidas, cerradas + canceladas y abiertas. */
export const KPIS_CRITERIO: KpiConciliacion[] = [
  'recibidas',
  'atendidas',
  'medidor_abiertas',
];

/** Error ponderado máximo para cumplir (5%). */
export const CRITERIO_ERROR_MAX = 0.05;

/** Lo nuestro de una semana (página de Maximo al corte de esa semana). */
export interface NuestraSemana {
  recibidas: number;
  nuevas: number;
  cerradas_anio: number;
  canceladas_anio: number;
  abiertas: number;
  cerradas_semana: number;
  dias_cierre_promedio: number | null;
  dias_cierre_mediana: number | null;
  dias_cancelacion: number | null;
  /** H1: PR cerradas en Maximo sin OC ni contrato (solo nuestro). */
  cerradas_sin_oc_ni_contrato: number;
  /** H2: PR de contrato cerradas al corte (contra las canceladas de Jorge). */
  cerradas_de_contrato: number;
}

export function nuestraSemana(page: AvancePage): NuestraSemana {
  return {
    recibidas: page.avance.recibidas_anio,
    nuevas: page.avance.nuevas_semana,
    cerradas_anio: page.estado_anio.cerradas,
    canceladas_anio: page.estado_anio.canceladas,
    abiertas: page.estado_anio.abiertas,
    cerradas_semana: page.avance.cerradas_semana,
    // O1.3: el número grande de la página (del año o de la semana)
    dias_cierre_promedio: page.cierre.titulo.dias?.promedio_dias ?? null,
    dias_cierre_mediana: page.cierre.titulo.dias?.mediana_dias ?? null,
    dias_cancelacion: page.cancelacion.titulo.dias?.promedio_dias ?? null,
    cerradas_sin_oc_ni_contrato: page.estado_anio.cerradas_sin_oc_ni_contrato,
    cerradas_de_contrato: page.estado_anio.cerradas_de_contrato,
  };
}

/** Qué identidades de la serie de Jorge cuadran en una página. */
export interface ValidezPagina {
  /** recibidas − recibidas de la semana anterior = nuevas (1a semana del año: recibidas = nuevas). */
  recibidas_nuevas: boolean;
  /** cerradas + canceladas + abiertas del medidor = recibidas. */
  medidor: boolean;
  /**
   * Con qué cuadra el titular de cerradas del año: las cerradas del medidor,
   * las cerradas + canceladas (p.27, p.28) o con nada (null).
   */
  titular_cerradas: 'cerradas' | 'atendidas' | null;
  /**
   * H15: la página repite los 9 valores de la semana anterior (la más nueva
   * del par es la copia): no se compara en ningún KPI.
   */
  copia: boolean;
}

/** Los 9 valores de una página de Jorge, en el orden de su archivo. */
const VALORES_PAGINA = (j: JorgeSemana) => [
  j.recibidas,
  j.nuevas,
  j.cerradas_anio,
  j.cerradas_semana,
  j.dias_cierre,
  j.dias_cancelacion,
  j.medidor_cerradas,
  j.medidor_canceladas,
  j.medidor_abiertas,
];

/** Motivo de una página copiada (H15). */
export const MOTIVO_COPIA =
  'página idéntica a la de la semana anterior (copia)';

const DAY_MS = 86_400_000;

/**
 * Validez de la página `i` (0 = p.1) por las identidades de la propia serie
 * (`semanas` va de la más nueva a la más vieja).
 */
export function validezPagina(
  semanas: JorgeSemana[],
  i: number,
): ValidezPagina {
  const j = semanas[i];
  const lunes = parseDay(j.lunes);
  const primeraDelAnio =
    lunes.getTime() === firstMondayOfYear(lunes.getUTCFullYear()).getTime();
  const anterior = semanas[i + 1];
  const esLaAnterior =
    anterior !== undefined &&
    parseDay(anterior.lunes).getTime() === lunes.getTime() - 7 * DAY_MS;
  // H15: copia = los 9 valores iguales a los de la semana anterior
  const valores = VALORES_PAGINA(j);
  const copia =
    esLaAnterior &&
    valores.some((v) => v !== null) &&
    VALORES_PAGINA(anterior).every((v, k) => v === valores[k]);
  let recibidasNuevas = false;
  if (j.recibidas !== null && j.nuevas !== null) {
    if (primeraDelAnio) {
      recibidasNuevas = j.recibidas === j.nuevas;
    } else if (
      anterior &&
      anterior.recibidas !== null &&
      parseDay(anterior.lunes).getTime() === lunes.getTime() - 7 * DAY_MS
    ) {
      recibidasNuevas = j.recibidas - anterior.recibidas === j.nuevas;
    }
  }
  const medidor =
    j.recibidas !== null &&
    j.medidor_cerradas !== null &&
    j.medidor_canceladas !== null &&
    j.medidor_abiertas !== null &&
    j.medidor_cerradas + j.medidor_canceladas + j.medidor_abiertas ===
      j.recibidas;
  let titular: ValidezPagina['titular_cerradas'] = null;
  if (j.cerradas_anio !== null && j.medidor_cerradas !== null) {
    if (j.cerradas_anio === j.medidor_cerradas) {
      titular = 'cerradas';
    } else if (
      j.medidor_canceladas !== null &&
      j.cerradas_anio === j.medidor_cerradas + j.medidor_canceladas
    ) {
      titular = 'atendidas';
    }
  }
  return {
    recibidas_nuevas: recibidasNuevas,
    medidor,
    titular_cerradas: titular,
    copia,
  };
}

export interface ComparacionKpi {
  kpi: KpiConciliacion;
  jorge: number | null;
  nuestro: number | null;
  /** Se compara: su identidad cuadra y los dos lados tienen dato. */
  valida: boolean;
  /** Por qué no se compara. */
  motivo: string | null;
}

export interface SemanaConciliada {
  pagina: number;
  lunes: string;
  validez: ValidezPagina;
  kpis: ComparacionKpi[];
  /** H1: PR cerradas en Maximo sin OC ni contrato al corte (solo nuestro). */
  cerradas_sin_oc_ni_contrato: number;
  /** H2: PR de Maximo de contrato cerradas al corte (solo nuestro). */
  cerradas_de_contrato: number;
}

const suma = (a: number | null, b: number | null) =>
  a === null || b === null ? null : a + b;

/** Valor de Jorge, el nuestro y la identidad que lo respalda, por KPI. */
const KPI_DEF: Record<
  KpiConciliacion,
  {
    jorge: (j: JorgeSemana) => number | null;
    nuestro: (n: NuestraSemana, v: ValidezPagina) => number | null;
    /** null = la identidad cuadra (o el KPI no tiene identidad). */
    identidad: (v: ValidezPagina) => string | null;
  }
> = {
  recibidas: {
    jorge: (j) => j.recibidas,
    nuestro: (n) => n.recibidas,
    identidad: (v) =>
      v.recibidas_nuevas
        ? null
        : 'recibidas − las de la semana anterior no da las nuevas',
  },
  nuevas: {
    jorge: (j) => j.nuevas,
    nuestro: (n) => n.nuevas,
    identidad: (v) =>
      v.recibidas_nuevas
        ? null
        : 'recibidas − las de la semana anterior no da las nuevas',
  },
  cerradas_anio: {
    jorge: (j) => j.cerradas_anio,
    // p.27, p.28: el titular son cerradas + canceladas; se compara contra eso
    nuestro: (n, v) =>
      v.titular_cerradas === 'atendidas'
        ? n.cerradas_anio + n.canceladas_anio
        : n.cerradas_anio,
    identidad: (v) =>
      v.titular_cerradas === null
        ? 'el titular de cerradas no cuadra con el medidor'
        : null,
  },
  cerradas_semana: {
    jorge: (j) => j.cerradas_semana,
    nuestro: (n) => n.cerradas_semana,
    identidad: () => null,
  },
  dias_cierre_promedio: {
    jorge: (j) => j.dias_cierre,
    nuestro: (n) => n.dias_cierre_promedio,
    identidad: () => null,
  },
  dias_cierre_mediana: {
    jorge: (j) => j.dias_cierre,
    nuestro: (n) => n.dias_cierre_mediana,
    identidad: () => null,
  },
  dias_cancelacion: {
    jorge: (j) => j.dias_cancelacion,
    nuestro: (n) => n.dias_cancelacion,
    identidad: () => null,
  },
  medidor_cerradas: {
    jorge: (j) => j.medidor_cerradas,
    nuestro: (n) => n.cerradas_anio,
    identidad: (v) => (v.medidor ? null : 'el medidor no suma las recibidas'),
  },
  medidor_canceladas: {
    jorge: (j) => j.medidor_canceladas,
    nuestro: (n) => n.canceladas_anio,
    identidad: (v) => (v.medidor ? null : 'el medidor no suma las recibidas'),
  },
  medidor_abiertas: {
    jorge: (j) => j.medidor_abiertas,
    nuestro: (n) => n.abiertas,
    identidad: (v) => (v.medidor ? null : 'el medidor no suma las recibidas'),
  },
  atendidas: {
    jorge: (j) => suma(j.medidor_cerradas, j.medidor_canceladas),
    nuestro: (n) => n.cerradas_anio + n.canceladas_anio,
    identidad: (v) => (v.medidor ? null : 'el medidor no suma las recibidas'),
  },
};

export interface ResumenKpi {
  kpi: KpiConciliacion;
  /** Semanas válidas comparadas. */
  semanas: number;
  /** Σ|nuestro − Jorge| / Σ Jorge, en %; null sin semanas válidas. */
  error_pct: number | null;
  error_absoluto_medio: number | null;
  /** Media de nuestro − Jorge (positivo = contamos de más). */
  sesgo: number | null;
}

export interface CriterioConciliacion {
  umbral_pct: number;
  kpis: Array<{
    kpi: KpiConciliacion;
    error_pct: number | null;
    cumple: boolean;
  }>;
  /** Error ≤5% en recibidas, cerradas + canceladas y abiertas. */
  cumple: boolean;
  /** Error absoluto medio de abiertas (PR por semana). */
  abiertas_error_absoluto_medio: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Error de una serie de pares (semanas válidas), sin el KPI. */
type ErrorSerie = Omit<ResumenKpi, 'kpi'> & { error: number | null };

/**
 * Σ|nuestro − Jorge| / Σ Jorge (ponderado), error absoluto medio y sesgo
 * (media de nuestro − Jorge) de los pares; sin pares, todo null.
 */
function errorSerie(
  pares: Array<{ jorge: number; nuestro: number }>,
): ErrorSerie {
  if (pares.length === 0) {
    return {
      semanas: 0,
      error: null,
      error_pct: null,
      error_absoluto_medio: null,
      sesgo: null,
    };
  }
  const abs = pares.reduce((s, p) => s + Math.abs(p.nuestro - p.jorge), 0);
  const jorge = pares.reduce((s, p) => s + p.jorge, 0);
  const dif = pares.reduce((s, p) => s + (p.nuestro - p.jorge), 0);
  const error = jorge === 0 ? null : abs / jorge;
  return {
    semanas: pares.length,
    error,
    error_pct: error === null ? null : round2(error * 100),
    error_absoluto_medio: round2(abs / pares.length),
    sesgo: round2(dif / pares.length),
  };
}

function resumenKpi(
  kpi: KpiConciliacion,
  semanas: SemanaConciliada[],
): ResumenKpi & { error: number | null } {
  const pares = semanas
    .map((s) => s.kpis.find((k) => k.kpi === kpi)!)
    .filter((k) => k.valida) as Array<
    ComparacionKpi & { jorge: number; nuestro: number }
  >;
  return { kpi, ...errorSerie(pares) };
}

/**
 * Hipótesis de la calibración del 5-oct que la conciliación prueba. H2: las
 * "canceladas" de Jorge serían nuestras PR de contrato cerradas (al 5-oct,
 * 126 y 126); H3 (días hábiles) se prueba con la variante
 * `dias_tipo=habiles` y no lleva cálculo aparte.
 */
export interface HipotesisConciliacion {
  h2: {
    /** Qué se compara (nuestro contra Jorge). */
    compara: string;
    /** Semanas donde el medidor de Jorge cuadra (las de medidor_canceladas). */
    semanas: number;
    /** Σ|nuestro − Jorge| / Σ Jorge, en %; null sin semanas. */
    error_pct: number | null;
    error_absoluto_medio: number | null;
    /** Media de nuestro − Jorge (positivo = contamos de más). */
    sesgo: number | null;
  };
  /** Cómo se prueba H3 (sin cálculo aparte). */
  h3: string;
}

export const HIPOTESIS_H2_COMPARA =
  'cerradas_de_contrato (PR de Maximo de contrato cerradas al corte) contra las canceladas del año de Jorge (medidor)';

/**
 * H2 con las semanas ya conciliadas: nuestras `cerradas_de_contrato` contra
 * las canceladas del medidor de Jorge, solo en las semanas donde ese KPI se
 * compara (su medidor cuadra, no es copia y trae el dato).
 */
export function hipotesisH2(
  semanas: SemanaConciliada[],
): HipotesisConciliacion['h2'] {
  const pares = semanas.flatMap((s) => {
    const k = s.kpis.find((c) => c.kpi === 'medidor_canceladas');
    return k?.valida && k.jorge !== null
      ? [{ jorge: k.jorge, nuestro: s.cerradas_de_contrato }]
      : [];
  });
  const r = errorSerie(pares);
  return {
    compara: HIPOTESIS_H2_COMPARA,
    semanas: r.semanas,
    error_pct: r.error_pct,
    error_absoluto_medio: r.error_absoluto_medio,
    sesgo: r.sesgo,
  };
}

/**
 * Compara la serie de Jorge con la nuestra (alineadas: `nuestras[i]` es la
 * semana de `jorge[i]`), con la validez por página, el resumen por KPI y el
 * criterio. Pura, para probarla con series sintéticas.
 */
export function compararSerie(
  jorge: JorgeSemana[],
  nuestras: NuestraSemana[],
): {
  semanas: SemanaConciliada[];
  resumen: ResumenKpi[];
  criterio: CriterioConciliacion;
} {
  const semanas = jorge.map((j, i): SemanaConciliada => {
    const n = nuestras[i];
    const v = validezPagina(jorge, i);
    const kpis = KPIS_CONCILIACION.map((kpi): ComparacionKpi => {
      const def = KPI_DEF[kpi];
      const deJorge = def.jorge(j);
      const nuestro = n ? def.nuestro(n, v) : null;
      // H15: la copia va antes de la identidad (también cubre los KPI sin
      // identidad: cerradas de la semana y días)
      const motivo =
        deJorge === null
          ? 'Jorge no tiene el dato'
          : v.copia
            ? MOTIVO_COPIA
            : (def.identidad(v) ??
              (nuestro === null ? 'no tenemos el dato' : null));
      return {
        kpi,
        jorge: deJorge,
        nuestro,
        valida: motivo === null,
        motivo,
      };
    });
    return {
      pagina: j.pagina,
      lunes: j.lunes,
      validez: v,
      kpis,
      cerradas_sin_oc_ni_contrato: n?.cerradas_sin_oc_ni_contrato ?? 0,
      cerradas_de_contrato: n?.cerradas_de_contrato ?? 0,
    };
  });
  const conError = KPIS_CONCILIACION.map((kpi) => resumenKpi(kpi, semanas));
  const resumen = conError.map(
    (r): ResumenKpi => ({
      kpi: r.kpi,
      semanas: r.semanas,
      error_pct: r.error_pct,
      error_absoluto_medio: r.error_absoluto_medio,
      sesgo: r.sesgo,
    }),
  );
  const criterioKpis = KPIS_CRITERIO.map((kpi) => {
    const r = conError.find((c) => c.kpi === kpi)!;
    return {
      kpi,
      error_pct: r.error_pct,
      cumple: r.error !== null && r.error <= CRITERIO_ERROR_MAX,
    };
  });
  return {
    semanas,
    resumen,
    criterio: {
      umbral_pct: CRITERIO_ERROR_MAX * 100,
      kpis: criterioKpis,
      cumple: criterioKpis.every((k) => k.cumple),
      abiertas_error_absoluto_medio: conError.find(
        (c) => c.kpi === 'medidor_abiertas',
      )!.error_absoluto_medio,
    },
  };
}

// ── Montos y anual ──────────────────────────────────────────────────────

/**
 * O1 (2026-10-26): las variantes de los montos de la página de Maximo, todas
 * sin las OC de contrato y con dólares y euros en pesos:
 *  - `tc_maximo`: con IVA, tipo de Maximo del día (la regla de O1);
 *  - `tc_sap`: con IVA, tipo de referencia de SAP del mes;
 *  - `sin_iva`: sin IVA, con el tipo pedido;
 *  - `sap_migradas`: con IVA, de las copias en SAP de las OC de Maximo.
 */
export type VarianteMonto = 'tc_maximo' | 'tc_sap' | 'sin_iva' | 'sap_migradas';

const variantes = (
  tipo: AvanceTipoCambio,
): Array<{
  clave: VarianteMonto;
  fuente: AvanceMontosFuente;
  base: AvanceMontoBase;
  tipo_cambio: AvanceTipoCambio;
}> => [
  {
    clave: 'tc_maximo',
    fuente: 'maximo',
    base: 'con_iva',
    tipo_cambio: 'maximo',
  },
  { clave: 'tc_sap', fuente: 'maximo', base: 'con_iva', tipo_cambio: 'sap' },
  { clave: 'sin_iva', fuente: 'maximo', base: 'sin_iva', tipo_cambio: tipo },
  {
    clave: 'sap_migradas',
    fuente: 'sap_migradas',
    base: 'con_iva',
    tipo_cambio: tipo,
  },
];

/** O1: el total de un tipo de cambio contra el de Jorge. */
export interface TotalContraJorge {
  total: number | null;
  /** nuestro − Jorge. */
  diferencia: number | null;
  /** (nuestro − Jorge) / Jorge, en %. */
  diferencia_pct: number | null;
}

export interface MontosConciliados {
  anio: number;
  /** Lunes de la semana del corte de nuestros montos. */
  corte_lunes: string;
  meses: Array<{
    mes: number;
    etiqueta: string;
    jorge: number;
    /**
     * MXN de la página de Maximo; null = la variante no tiene MXN o (H9) el
     * mes solo trae OC sin subtotal en una variante sin IVA.
     */
    nuestro: Record<VarianteMonto, number | null>;
  }>;
  total: {
    /** Suma de sus meses. */
    jorge: number;
    /** El total que Jorge escribió. */
    jorge_escrito: number | null;
    nuestro: Record<VarianteMonto, number | null>;
  };
  /** Σ|nuestro − Jorge| / Σ Jorge por mes, en %. */
  error_pct: Record<VarianteMonto, number | null>;
  /** OC sin subtotal por fuente (no entran a las variantes sin IVA). */
  sin_subtotal: Record<AvanceMontosFuente, number>;
  /** Monedas que quedaron sin convertir (sin tipo de cambio), por variante. */
  otras_monedas: Record<VarianteMonto, Record<string, number>>;
  /**
   * O1.5: el total del año (al corte) con cada tipo de cambio contra el que
   * Jorge escribió (o la suma de sus meses), y cuál queda más cerca. Solo se
   * decide si los dos convirtieron las mismas OC (`comparable`: lo que quedó
   * sin convertir es igual); si no, `mas_cercano` es null.
   */
  tipo_cambio: {
    jorge: number;
    maximo: TotalContraJorge;
    sap: TotalContraJorge;
    comparable: boolean;
    mas_cercano: AvanceTipoCambio | null;
  };
  /** O1: las de contrato que no se sumaron y las convertidas (tipo de Maximo). */
  maximo: MontosMaximo | null;
}

/** Montos MXN de la página de Maximo de un año contra los de Jorge. */
export function montosConciliados(
  data: AvanceData,
  anio: number,
  lunes: Date,
  opciones: AvanceOpciones,
): MontosConciliados {
  const jorge = JORGE_MONTOS[anio] ?? [];
  const porVariante = variantes(opciones.tipo_cambio).map((v) => ({
    ...v,
    montos: montosAdjudicados(
      data.ordenes,
      'maximo',
      anio,
      lunes,
      {
        ...opciones,
        monto_base: v.base,
        montos_fuente_maximo: v.fuente,
        tipo_cambio: v.tipo_cambio,
      },
      data.tipos_cambio,
    ),
  }));
  const record = <T>(pick: (v: (typeof porVariante)[number]) => T) =>
    Object.fromEntries(porVariante.map((v) => [v.clave, pick(v)])) as Record<
      VarianteMonto,
      T
    >;
  const meses = jorge.map((valor, i) => ({
    mes: i + 1,
    etiqueta: MESES_TITULO[i],
    jorge: valor,
    nuestro: record((v) => {
      if (v.montos.total.MXN === undefined) return null;
      const mes = v.montos.meses[i];
      const valor = mes?.montos.MXN;
      if (valor !== undefined) return round2(valor);
      // H9: mes con OC sin subtotal (sin IVA) = no disponible, no 0
      return mes?.sin_subtotal.MXN ? null : 0;
    }),
  }));
  const sumaJorge = round2(jorge.reduce((s, v) => s + v, 0));
  // O1.5: contra el total que Jorge escribió (94.67 M al 25-sep de 2026)
  const totalJorge = JORGE_MONTOS_TOTAL[anio] ?? sumaJorge;
  const contraJorge = (clave: VarianteMonto): TotalContraJorge => {
    const total =
      porVariante.find((v) => v.clave === clave)?.montos.total.MXN ?? null;
    if (total === null || totalJorge === 0) {
      return { total, diferencia: null, diferencia_pct: null };
    }
    return {
      total,
      diferencia: round2(total - totalJorge),
      diferencia_pct: round2(((total - totalJorge) / totalJorge) * 100),
    };
  };
  const tcMaximo = contraJorge('tc_maximo');
  const tcSap = contraJorge('tc_sap');
  // lo que cada tipo dejó sin convertir: si difiere, no son las mismas OC
  const sinConvertir = (clave: VarianteMonto) =>
    JSON.stringify(
      Object.entries(
        porVariante.find((v) => v.clave === clave)?.montos.total ?? {},
      )
        .filter(([moneda]) => moneda !== 'MXN')
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  const comparable = sinConvertir('tc_maximo') === sinConvertir('tc_sap');
  const masCercano: AvanceTipoCambio | null =
    !comparable || tcMaximo.diferencia === null || tcSap.diferencia === null
      ? null
      : Math.abs(tcMaximo.diferencia) <= Math.abs(tcSap.diferencia)
        ? 'maximo'
        : 'sap';
  return {
    anio,
    corte_lunes: isoDay(lunes),
    meses,
    total: {
      jorge: sumaJorge,
      jorge_escrito: JORGE_MONTOS_TOTAL[anio] ?? null,
      nuestro: record((v) => v.montos.total.MXN ?? null),
    },
    error_pct: record((v) => {
      if (v.montos.total.MXN === undefined || sumaJorge === 0) return null;
      const abs = meses.reduce(
        (s, m) => s + Math.abs((m.nuestro[v.clave] ?? 0) - m.jorge),
        0,
      );
      return round2((abs / sumaJorge) * 100);
    }),
    sin_subtotal: {
      maximo: porVariante[0].montos.sin_subtotal.ordenes,
      sap_migradas: porVariante[3].montos.sin_subtotal.ordenes,
    },
    otras_monedas: record((v) =>
      Object.fromEntries(
        Object.entries(v.montos.total).filter(([moneda]) => moneda !== 'MXN'),
      ),
    ),
    tipo_cambio: {
      jorge: totalJorge,
      maximo: tcMaximo,
      sap: tcSap,
      comparable,
      mas_cercano: masCercano,
    },
    maximo: porVariante[0].montos.maximo,
  };
}

/** O1.5: una cifra del informe de RQ de Jorge contra nuestra página. */
export interface RqConciliada {
  dia: string;
  /** Lunes de nuestra semana (nuevas y cerradas de la semana). */
  semana_lunes: string;
  jorge: JorgeRq;
  /**
   * Nuevas y cerradas de la semana solo si el día del informe es el del
   * corte (el viernes); si no, null: la semana incluiría días posteriores.
   */
  nuestro: {
    recibidas: number;
    nuevas: number | null;
    cerradas: number;
    cerradas_semana: number | null;
    canceladas: number;
    abiertas: number;
  };
  /** nuestro − Jorge; null donde Jorge no dio la cifra. */
  diferencia: {
    recibidas: number;
    nuevas: number | null;
    cerradas: number;
    cerradas_semana: number | null;
    canceladas: number | null;
    abiertas: number | null;
  };
}

export const RQ_OCTUBRE_NOTA =
  'Jorge cuenta solicitudes de cotización (RQ) creadas en el año; nuestra página de Maximo cuenta PR aprobadas (llegada a Compras). La diferencia esperada son las PR que no llegan a RQ (p. ej. canceladas para cambiar el alcance) y se cierra con O2.';

/**
 * O1.5: las cifras del informe de RQ de Jorge del 16 y del 20-oct contra
 * nuestra página de Maximo: el estado del año al final de ese día y, de su
 * semana, las nuevas y las cerradas.
 */
export function rqOctubre(
  data: AvanceData,
  opciones: AvanceOpciones,
  generado: Date,
  puntos: JorgeRq[] = JORGE_RQ,
): RqConciliada[] {
  const menos = (a: number | null, b: number | null) =>
    a === null || b === null ? null : a - b;
  return puntos.map((j) => {
    const dia = parseDay(j.dia);
    const cohorte = cohorteAlDia(data, dia, 'maximo', opciones);
    const lunes = mondayOf(dia);
    const pagina = buildAvancePage(data, lunes, 'maximo', generado, opciones);
    // la semana de la página termina en su día de corte
    const diaDeCorte =
      pagina.semana.corte_dia === 'viernes'
        ? pagina.semana.viernes
        : pagina.semana.domingo;
    const enCorte = diaDeCorte === j.dia;
    const nuestro = {
      recibidas: cohorte.recibidas,
      nuevas: enCorte ? pagina.avance.nuevas_semana : null,
      cerradas: cohorte.cerradas,
      cerradas_semana: enCorte ? pagina.avance.cerradas_semana : null,
      canceladas: cohorte.canceladas,
      abiertas: cohorte.abiertas,
    };
    return {
      dia: j.dia,
      semana_lunes: isoDay(lunes),
      jorge: j,
      nuestro,
      diferencia: {
        recibidas: nuestro.recibidas - j.recibidas,
        nuevas: menos(nuestro.nuevas, j.nuevas),
        cerradas: nuestro.cerradas - j.cerradas,
        cerradas_semana: menos(nuestro.cerradas_semana, j.cerradas_semana),
        canceladas: menos(nuestro.canceladas, j.canceladas),
        abiertas: menos(nuestro.abiertas, j.abiertas),
      },
    };
  });
}

export interface AnualConciliado {
  anio: number;
  jorge: {
    recibidas: number;
    atendidas: number;
    cerradas: number | null;
    canceladas: number | null;
  };
  nuestro: {
    recibidas: number;
    atendidas: number;
    cerradas: number;
    canceladas: number;
    abiertas: number;
  };
  nota: string | null;
}

export interface ConciliacionAvance {
  opciones: AvanceOpciones;
  generado: string;
  maximo: {
    /** PR del universo (con la fecha de inicio de la regla). */
    gestiones: number;
    /**
     * PR fuera del universo HOY (todas las fechas); cada página cuenta las
     * suyas al corte (H6: también las aprobadas después del corte).
     */
    no_recibidas: number;
  };
  semanas: SemanaConciliada[];
  resumen: ResumenKpi[];
  criterio: CriterioConciliacion;
  /** H2 (contrato cerradas contra canceladas de Jorge) y cómo probar H3. */
  hipotesis: HipotesisConciliacion;
  montos: MontosConciliados[];
  /** O1.5: su informe de RQ del 16 y del 20-oct contra nuestra página. */
  rq_octubre: { nota: string; puntos: RqConciliada[] };
  /** Al corte de la p.1; el 2025 de Jorge no cuadra en su origen (nota). */
  anual: AnualConciliado[];
  /** P.39 de Jorge contra nuestra cohorte 2025 al corte de su última semana. */
  cierre_2025: {
    jorge: typeof JORGE_CIERRE_2025;
    nuestro: {
      recibidas: number;
      cerradas: number;
      canceladas: number;
      abiertas: number;
      dias_cierre_promedio: number | null;
      dias_cierre_mediana: number | null;
      dias_cancelacion: number | null;
    };
  };
}

/** Variante pedida: lo que no viene toma el default (AVANCE_REGLAS y montos). */
export function opcionesConciliacion(p: {
  recibida?: AvanceInicio;
  dias_desde?: AvanceInicio;
  montos?: AvanceMontosFuente;
  corte?: AvanceCorte;
  dias_tipo?: AvanceDiasTipo;
  tipo_cambio?: AvanceTipoCambio;
  promedio_titulo?: AvancePromedioTitulo;
}): AvanceOpciones {
  return {
    reglas: {
      ...AVANCE_REGLAS,
      recibida: p.recibida ?? AVANCE_REGLAS.recibida,
      dias_desde: p.dias_desde ?? AVANCE_REGLAS.dias_desde,
      corte: p.corte ?? AVANCE_REGLAS.corte,
      dias_tipo: p.dias_tipo ?? AVANCE_REGLAS.dias_tipo,
    },
    monto_base: AVANCE_MONTO_BASE,
    montos_fuente_maximo: p.montos ?? AVANCE_MONTOS_FUENTE_MAXIMO,
    tipo_cambio: p.tipo_cambio ?? AVANCE_TIPO_CAMBIO,
    promedio_titulo: p.promedio_titulo ?? AVANCE_PROMEDIO_TITULO,
  };
}

/** H3: cómo se prueba con esta corrida (sin cálculo aparte). */
function notaH3(opciones: AvanceOpciones): string {
  return opciones.reglas.dias_tipo === 'habiles'
    ? 'H3 (días hábiles): esta corrida cuenta días hábiles (dias_tipo=habiles); compara dias_cierre_promedio y dias_cierre_mediana del resumen con la corrida en días naturales.'
    : 'H3 (días hábiles): esta corrida cuenta días naturales; para probarla, corre la variante dias_tipo=habiles y compara dias_cierre_promedio y dias_cierre_mediana del resumen.';
}

/**
 * Conciliación completa con los datos ya cargados (con `opciones.reglas`):
 * las 38 semanas, el resumen, el criterio, los montos de 2026 y 2025 y el
 * anual.
 */
export function conciliarAvance(
  data: AvanceData,
  opciones: AvanceOpciones,
  generado: Date,
): ConciliacionAvance {
  const jorge = jorgeSemanas();
  const paginas = jorge.map((j) =>
    buildAvancePage(data, parseDay(j.lunes), 'maximo', generado, opciones),
  );
  const serie = compararSerie(jorge, paginas.map(nuestraSemana));

  const ultima = paginas[0];
  const anual: AnualConciliado[] = [
    ...JORGE_ANUAL,
    {
      anio: ultima.semana.anio,
      recibidas: jorge[0].recibidas ?? 0,
      atendidas:
        suma(jorge[0].medidor_cerradas, jorge[0].medidor_canceladas) ?? 0,
      cerradas: jorge[0].medidor_cerradas,
      canceladas: jorge[0].medidor_canceladas,
      nota: null,
    },
  ].map((j) => {
    const c = ultima.anual.find((a) => a.anio === j.anio);
    return {
      anio: j.anio,
      jorge: {
        recibidas: j.recibidas,
        atendidas: j.atendidas,
        cerradas: j.cerradas,
        canceladas: j.canceladas,
      },
      nuestro: {
        recibidas: c?.recibidas ?? 0,
        atendidas: c?.atendidas ?? 0,
        cerradas: c?.cerradas ?? 0,
        canceladas: c?.canceladas ?? 0,
        abiertas: c?.abiertas ?? 0,
      },
      nota: j.nota,
    };
  });

  // P.39 = semana del 29-dic-2025 (del año de su lunes, como en su archivo)
  const lunes2025 = new Date(JORGE_LATEST - JORGE_SEMANAS * 7 * DAY_MS);
  const pagina2025 = buildAvancePage(
    data,
    lunes2025,
    'maximo',
    generado,
    opciones,
  );
  const lunesUltima = parseDay(ultima.semana.lunes);

  return {
    opciones,
    generado: generado.toISOString(),
    maximo: {
      gestiones: data.gestiones.filter((g) => g.sistema === 'maximo').length,
      no_recibidas: data.maximo_no_recibidas.length,
    },
    semanas: serie.semanas,
    resumen: serie.resumen,
    criterio: serie.criterio,
    hipotesis: { h2: hipotesisH2(serie.semanas), h3: notaH3(opciones) },
    montos: [
      montosConciliados(data, ultima.semana.anio, lunesUltima, opciones),
      montosConciliados(data, pagina2025.semana.anio, lunes2025, opciones),
    ],
    rq_octubre: {
      nota: RQ_OCTUBRE_NOTA,
      puntos: rqOctubre(data, opciones, generado),
    },
    anual,
    cierre_2025: {
      jorge: JORGE_CIERRE_2025,
      nuestro: {
        recibidas: pagina2025.estado_anio.recibidas,
        cerradas: pagina2025.estado_anio.cerradas,
        canceladas: pagina2025.estado_anio.canceladas,
        abiertas: pagina2025.estado_anio.abiertas,
        dias_cierre_promedio: pagina2025.cierre.anio.promedio_dias,
        dias_cierre_mediana: pagina2025.cierre.anio.mediana_dias,
        dias_cancelacion: pagina2025.cancelacion.anio?.promedio_dias ?? null,
      },
    },
  };
}
