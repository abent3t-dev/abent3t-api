import {
  type AvanceData,
  type AvancePage,
  buildAvancePage,
  firstMondayOfYear,
  isoDay,
  MESES_TITULO,
  montosAdjudicados,
  parseDay,
} from './avance-semanal.engine';
import {
  AVANCE_MONTO_BASE,
  AVANCE_MONTOS_FUENTE_MAXIMO,
  AVANCE_REGLAS,
  type AvanceCorte,
  type AvanceInicio,
  type AvanceMontoBase,
  type AvanceMontosFuente,
  type AvanceOpciones,
} from './avance-semanal.reglas';
import {
  JORGE_ANUAL,
  JORGE_CIERRE_2025,
  JORGE_LATEST,
  JORGE_MONTOS,
  JORGE_MONTOS_TOTAL,
  JORGE_SEMANAS,
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
}

export function nuestraSemana(page: AvancePage): NuestraSemana {
  return {
    recibidas: page.avance.recibidas_anio,
    nuevas: page.avance.nuevas_semana,
    cerradas_anio: page.estado_anio.cerradas,
    canceladas_anio: page.estado_anio.canceladas,
    abiertas: page.estado_anio.abiertas,
    cerradas_semana: page.avance.cerradas_semana,
    dias_cierre_promedio: page.cierre.anio.promedio_dias,
    dias_cierre_mediana: page.cierre.anio.mediana_dias,
    dias_cancelacion: page.cancelacion.anio?.promedio_dias ?? null,
    cerradas_sin_oc_ni_contrato: page.estado_anio.cerradas_sin_oc_ni_contrato,
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

function resumenKpi(
  kpi: KpiConciliacion,
  semanas: SemanaConciliada[],
): ResumenKpi & { error: number | null } {
  const pares = semanas
    .map((s) => s.kpis.find((k) => k.kpi === kpi)!)
    .filter((k) => k.valida) as Array<
    ComparacionKpi & { jorge: number; nuestro: number }
  >;
  if (pares.length === 0) {
    return {
      kpi,
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
    kpi,
    semanas: pares.length,
    error,
    error_pct: error === null ? null : round2(error * 100),
    error_absoluto_medio: round2(abs / pares.length),
    sesgo: round2(dif / pares.length),
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

export type VarianteMonto =
  | 'maximo_con_iva'
  | 'maximo_sin_iva'
  | 'sap_migradas_con_iva'
  | 'sap_migradas_sin_iva';

const VARIANTES: Array<{
  clave: VarianteMonto;
  fuente: AvanceMontosFuente;
  base: AvanceMontoBase;
}> = [
  { clave: 'maximo_con_iva', fuente: 'maximo', base: 'con_iva' },
  { clave: 'maximo_sin_iva', fuente: 'maximo', base: 'sin_iva' },
  { clave: 'sap_migradas_con_iva', fuente: 'sap_migradas', base: 'con_iva' },
  { clave: 'sap_migradas_sin_iva', fuente: 'sap_migradas', base: 'sin_iva' },
];

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
  /** Otras monedas (sin convertir), por variante. */
  otras_monedas: Record<VarianteMonto, Record<string, number>>;
}

/** Montos MXN de la página de Maximo de un año contra los de Jorge. */
export function montosConciliados(
  data: AvanceData,
  anio: number,
  lunes: Date,
  opciones: AvanceOpciones,
): MontosConciliados {
  const jorge = JORGE_MONTOS[anio] ?? [];
  const porVariante = VARIANTES.map((v) => ({
    ...v,
    montos: montosAdjudicados(data.ordenes, 'maximo', anio, lunes, {
      ...opciones,
      monto_base: v.base,
      montos_fuente_maximo: v.fuente,
    }),
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
      sap_migradas: porVariante[2].montos.sin_subtotal.ordenes,
    },
    otras_monedas: record((v) =>
      Object.fromEntries(
        Object.entries(v.montos.total).filter(([moneda]) => moneda !== 'MXN'),
      ),
    ),
  };
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
  montos: MontosConciliados[];
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
}): AvanceOpciones {
  return {
    reglas: {
      ...AVANCE_REGLAS,
      recibida: p.recibida ?? AVANCE_REGLAS.recibida,
      dias_desde: p.dias_desde ?? AVANCE_REGLAS.dias_desde,
      corte: p.corte ?? AVANCE_REGLAS.corte,
    },
    monto_base: AVANCE_MONTO_BASE,
    montos_fuente_maximo: p.montos ?? AVANCE_MONTOS_FUENTE_MAXIMO,
  };
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
    montos: [
      montosConciliados(data, ultima.semana.anio, lunesUltima, opciones),
      montosConciliados(data, pagina2025.semana.anio, lunes2025, opciones),
    ],
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
