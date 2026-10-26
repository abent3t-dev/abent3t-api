/**
 * K5 (2026-10-05) — Reglas del "Reporte de avance semanal" que esperan
 * respuesta de Ingrid o Jorge. Si contestan otra cosa, se cambia la
 * constante y nada más: `buildAvanceData` y `buildAvancePage` las reciben
 * como parámetro (default = estas constantes) para que la conciliación
 * (`GET /compras/reportes/avance-semanal/conciliacion`) pruebe variantes.
 *
 * L2 (2026-10-08): `AVANCE_GRUPOS_MAXIMO` (grupos de la página de Maximo)
 * va aparte de `AvanceOpciones` para que, sin el parámetro, el JSON de la
 * página (que trae `opciones`) no cambie.
 *
 * Solo el avance lee estas constantes: los pendientes del tablero, Reportes
 * y los listados ubican la PR por su llegada a Compras FIJA
 * (`maximoPrLlegada` en erp-views), y no se mueven si aquí cambia el default.
 *
 * O1 (2026-10-26, sesión con Jorge del 20-oct y datos de CIISA del 26-oct):
 * corte el viernes, días hábiles y montos con IVA. En la página de Maximo,
 * sin las OC de contrato y con dólares y euros pasados a pesos
 * (`AVANCE_TIPO_CAMBIO`). El promedio del título queda detrás de
 * `AVANCE_PROMEDIO_TITULO` hasta que Jorge confirme cuál usa.
 */

/** Desde dónde cuenta una PR de Maximo: primer APPR o ISSUEDATE. */
export type AvanceInicio = 'aprobacion' | 'emision';

/** Fin de la semana: domingo o viernes, 23:59 hora de México. */
export type AvanceCorte = 'domingo' | 'viernes';

/**
 * Cómo se cuentan los días de cierre y de cancelación: naturales o hábiles
 * (lunes a viernes sin los festivos activos de la tabla `holidays`).
 */
export type AvanceDiasTipo = 'naturales' | 'habiles';

export interface AvanceReglas {
  /**
   * Recibida (inicio R) y universo de Maximo: 'aprobacion' = primer APPR
   * (`pr_approved_at`), y las PR sin APPR quedan fuera (se cuentan aparte);
   * 'emision' = ISSUEDATE (`pr_issue_date`) de todas las PR que lo traen.
   */
  recibida: AvanceInicio;
  /** Inicio de los días de cierre y de cancelación de Maximo. */
  dias_desde: AvanceInicio;
  /** coalesce(primera OC vigente no cancelada, último CLOSE de la PR). */
  cerrada: 'primera_oc_o_close';
  /** Última CAN del historial PRSTATUS (`pr_cancelled_at`). */
  cancelada: 'can_historial';
  corte: AvanceCorte;
  /**
   * Días de cierre y de cancelación (las dos páginas, homologadas):
   * 'naturales' = el tiempo corrido (`gestionDays`); 'habiles' = solo el
   * tiempo que cae de lunes a viernes, sin los festivos activos de la tabla
   * `holidays` (si está vacía, solo se quitan sábados y domingos).
   */
  dias_tipo: AvanceDiasTipo;
}

export const AVANCE_REGLAS = {
  recibida: 'aprobacion', // 'aprobacion' | 'emision'
  dias_desde: 'aprobacion', // 'aprobacion' | 'emision'
  cerrada: 'primera_oc_o_close', // coalesce(primera OC vigente, último CLOSE)
  cancelada: 'can_historial', // última CAN del historial PRSTATUS
  // O1 (2026-10-26, Jorge el 20-oct): la semana cierra el viernes (23:59
  // hora de México); lo de sábado y domingo cuenta en la siguiente
  corte: 'viernes', // 'domingo' | 'viernes'
  // O1: días hábiles, como Jorge (lunes a viernes sin los festivos activos
  // de la tabla holidays; él confirma por correo si descuenta festivos). H3
  // de la calibración (5-oct): 17.1 días naturales ≈ 12 hábiles
  dias_tipo: 'habiles', // 'naturales' | 'habiles'
} as const satisfies AvanceReglas;

/** Base de los montos adjudicados (K6: `subtotal` = suma de las líneas). */
export type AvanceMontoBase = 'sin_iva' | 'con_iva';

/**
 * De dónde salen los montos de la página de Maximo: sus OC ('maximo') o las
 * OC de SAP que la integración creó desde Maximo ('sap_migradas').
 */
export type AvanceMontosFuente = 'maximo' | 'sap_migradas';

// O1 (2026-10-26): con IVA, como Jorge (solo el avance; Órdenes, CAPEX/OPEX
// y el resto de Compras siguen con su base)
export const AVANCE_MONTO_BASE: AvanceMontoBase = 'con_iva';
export const AVANCE_MONTOS_FUENTE_MAXIMO: AvanceMontosFuente = 'maximo';

/**
 * O1 (2026-10-26) — Con qué tipo de cambio pasan a pesos las OC de Maximo
 * en dólares y en euros (solo la página de Maximo del avance):
 *  - 'maximo': el del día de Maximo. EXCHANGERATE va CONTRA EL DÓLAR (la
 *    moneda base de Maximo): pesos por dólar = 1 / el EXCHANGERATE de las OC
 *    en pesos de ese día (o del día anterior más cercano que lo tenga); en
 *    euros, además × el EXCHANGERATE de la OC. Si no hay tipo del día, el
 *    de referencia de SAP del mes, y la nota lo dice;
 *  - 'sap': el de referencia de SAP del mes (promedio de DocTotal /
 *    DocTotalFc de sus OC en esa moneda, 17.0 a 17.7 por dólar en 2026).
 * La conciliación compara los dos contra los montos de Jorge.
 */
export type AvanceTipoCambio = 'maximo' | 'sap';

export const AVANCE_TIPO_CAMBIO: AvanceTipoCambio = 'maximo';

/**
 * O1.3 — El promedio grande de las tarjetas de días ("Tiempo de cierre de
 * gestiones"): el del año (como hasta hoy) o el de la semana (lo que dijo
 * Jorge). Falta que lo confirme: su reporte del 25-sep dice 11 en el título
 * y 16 en la semana al 25. Se cambia aquí y nada más.
 */
export type AvancePromedioTitulo = 'anio' | 'semana';

export const AVANCE_PROMEDIO_TITULO: AvancePromedioTitulo = 'anio';

/**
 * L2 (2026-10-08) — Grupos de las recibidas en la página de Maximo (dona,
 * medidores por año y barras). Las "canceladas" de Jorge se parecen a
 * nuestras PR de contrato cerradas (OC automática), no a las CAN de Maximo
 * (diagnóstico del 5-oct, H2):
 *  - 'estandar': cerradas · canceladas · abiertas (como hasta hoy);
 *  - 'contrato': las PR de contrato cerradas van aparte ("De contrato (OC
 *    automática)"), las canceladas se llaman "Canceladas en Maximo" (CAN del
 *    historial) y las cerradas que quedan son las sin contrato.
 * Solo presentación: los KPIs, sus nombres y la página de SAP no cambian.
 */
export type AvanceGrupos = 'estandar' | 'contrato';

// Vista previa para la reunión con Ingrid (8-oct); el default espera a
// Jorge/Ingrid. Si aprueban 'contrato', se cambia esta constante y nada más;
// el parámetro `grupos` del JSON y del PDF del avance la sobreescribe.
export const AVANCE_GRUPOS_MAXIMO: AvanceGrupos = 'estandar';

export const AVANCE_GRUPOS: AvanceGrupos[] = ['estandar', 'contrato'];

/** Lo que reciben el motor y la conciliación (default = las constantes). */
export interface AvanceOpciones {
  reglas: AvanceReglas;
  monto_base: AvanceMontoBase;
  montos_fuente_maximo: AvanceMontosFuente;
  /** O1: tipo de cambio de las OC de Maximo en dólares y euros. */
  tipo_cambio: AvanceTipoCambio;
  /** O1.3: el promedio del título de las tarjetas de días. */
  promedio_titulo: AvancePromedioTitulo;
}

export const AVANCE_OPCIONES: AvanceOpciones = {
  reglas: AVANCE_REGLAS,
  monto_base: AVANCE_MONTO_BASE,
  montos_fuente_maximo: AVANCE_MONTOS_FUENTE_MAXIMO,
  tipo_cambio: AVANCE_TIPO_CAMBIO,
  promedio_titulo: AVANCE_PROMEDIO_TITULO,
};

export const AVANCE_INICIOS: AvanceInicio[] = ['aprobacion', 'emision'];
export const AVANCE_CORTES: AvanceCorte[] = ['domingo', 'viernes'];
export const AVANCE_DIAS_TIPOS: AvanceDiasTipo[] = ['naturales', 'habiles'];
export const AVANCE_MONTOS_FUENTES: AvanceMontosFuente[] = [
  'maximo',
  'sap_migradas',
];
export const AVANCE_TIPOS_CAMBIO: AvanceTipoCambio[] = ['maximo', 'sap'];
export const AVANCE_PROMEDIOS_TITULO: AvancePromedioTitulo[] = [
  'anio',
  'semana',
];

/** O1: "tipo de cambio de Maximo del día" / "de referencia de SAP del mes". */
export function tipoCambioTexto(tipo: AvanceTipoCambio): string {
  return tipo === 'maximo'
    ? 'el tipo de cambio de Maximo del día'
    : 'el tipo de cambio de referencia de SAP del mes';
}

/** "días" / "días hábiles", para los textos de la página, el PDF y el Excel. */
export function diasTexto(tipo: AvanceDiasTipo): string {
  return tipo === 'habiles' ? 'días hábiles' : 'días';
}

/** "sin IVA" / "con IVA", para los textos de la página, el PDF y el Excel. */
export function montoBaseTexto(base: AvanceMontoBase): string {
  return base === 'sin_iva' ? 'sin IVA' : 'con IVA';
}

/** La otra base (el dato secundario de los montos). */
export function otraBase(base: AvanceMontoBase): AvanceMontoBase {
  return base === 'sin_iva' ? 'con_iva' : 'sin_iva';
}

/**
 * Reglas vigentes del avance para quien no pide la semana (tarjeta de
 * Reportes): `GET /compras/reportes/avance-semanal/reglas`, sin tocar la BD.
 */
export interface AvanceReglasVigentes {
  monto_base: AvanceMontoBase;
  /** "sin IVA" / "con IVA". */
  monto_base_texto: string;
  otra_base: AvanceMontoBase;
  otra_base_texto: string;
  /**
   * Frase lista para la tarjeta: la base, dónde va el otro valor y (O1) qué
   * cambia en la página de Maximo.
   */
  monto_base_nota: string;
  montos_fuente_maximo: AvanceMontosFuente;
  /** O1: tipo de cambio de las OC de Maximo en dólares y euros. */
  tipo_cambio: AvanceTipoCambio;
  /** O1.3: el promedio del título de las tarjetas de días. */
  promedio_titulo: AvancePromedioTitulo;
  /** Todas las reglas, con `dias_tipo` (naturales o hábiles, H3). */
  reglas: AvanceReglas;
}

/**
 * H4 (2026-10-05): la tarjeta de Reportes decía "Montos sin IVA" escrito a
 * mano; con esto, cambiar AVANCE_MONTO_BASE basta (sin deploy de next).
 */
export function avanceReglasVigentes(
  opciones: AvanceOpciones = AVANCE_OPCIONES,
): AvanceReglasVigentes {
  const base = opciones.monto_base;
  const otra = otraBase(base);
  return {
    monto_base: base,
    monto_base_texto: montoBaseTexto(base),
    otra_base: otra,
    otra_base_texto: montoBaseTexto(otra),
    monto_base_nota: `${
      base === 'sin_iva'
        ? 'Montos sin IVA (suma de las líneas de la OC; las OC sin subtotal no se suman ni se estiman); el valor con IVA va en una línea chica.'
        : 'Montos con IVA; el valor sin IVA (suma de las líneas de la OC, solo de las que lo traen) va en una línea chica.'
    } En Maximo, sin las OC de contrato y con dólares y euros en pesos (${tipoCambioTexto(opciones.tipo_cambio)}), como el reporte de Compras; solo en este reporte.`,
    montos_fuente_maximo: opciones.montos_fuente_maximo,
    tipo_cambio: opciones.tipo_cambio,
    promedio_titulo: opciones.promedio_titulo,
    reglas: { ...opciones.reglas },
  };
}
