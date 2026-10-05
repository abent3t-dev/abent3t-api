/**
 * K5 (2026-10-05) — Reglas del "Reporte de avance semanal" que esperan
 * respuesta de Ingrid o Jorge. Si contestan otra cosa, se cambia la
 * constante y nada más: `buildAvanceData` y `buildAvancePage` las reciben
 * como parámetro (default = estas constantes) para que la conciliación
 * (`GET /compras/reportes/avance-semanal/conciliacion`) pruebe variantes.
 *
 * Solo el avance lee estas constantes: los pendientes del tablero, Reportes
 * y los listados ubican la PR por su llegada a Compras FIJA
 * (`maximoPrLlegada` en erp-views), y no se mueven si aquí cambia el default.
 */

/** Desde dónde cuenta una PR de Maximo: primer APPR o ISSUEDATE. */
export type AvanceInicio = 'aprobacion' | 'emision';

/** Fin de la semana: domingo o viernes, 23:59 hora de México. */
export type AvanceCorte = 'domingo' | 'viernes';

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
}

export const AVANCE_REGLAS = {
  recibida: 'aprobacion', // 'aprobacion' | 'emision'
  dias_desde: 'aprobacion', // 'aprobacion' | 'emision'
  cerrada: 'primera_oc_o_close', // coalesce(primera OC vigente, último CLOSE)
  cancelada: 'can_historial', // última CAN del historial PRSTATUS
  corte: 'domingo', // 'domingo' | 'viernes' (23:59 hora de México)
} as const satisfies AvanceReglas;

/** Base de los montos adjudicados (K6: `subtotal` = suma de las líneas). */
export type AvanceMontoBase = 'sin_iva' | 'con_iva';

/**
 * De dónde salen los montos de la página de Maximo: sus OC ('maximo') o las
 * OC de SAP que la integración creó desde Maximo ('sap_migradas').
 */
export type AvanceMontosFuente = 'maximo' | 'sap_migradas';

export const AVANCE_MONTO_BASE: AvanceMontoBase = 'sin_iva'; // a confirmar con Ingrid
export const AVANCE_MONTOS_FUENTE_MAXIMO: AvanceMontosFuente = 'maximo';

/** Lo que reciben el motor y la conciliación (default = las constantes). */
export interface AvanceOpciones {
  reglas: AvanceReglas;
  monto_base: AvanceMontoBase;
  montos_fuente_maximo: AvanceMontosFuente;
}

export const AVANCE_OPCIONES: AvanceOpciones = {
  reglas: AVANCE_REGLAS,
  monto_base: AVANCE_MONTO_BASE,
  montos_fuente_maximo: AVANCE_MONTOS_FUENTE_MAXIMO,
};

export const AVANCE_INICIOS: AvanceInicio[] = ['aprobacion', 'emision'];
export const AVANCE_CORTES: AvanceCorte[] = ['domingo', 'viernes'];
export const AVANCE_MONTOS_FUENTES: AvanceMontosFuente[] = [
  'maximo',
  'sap_migradas',
];

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
  /** Frase lista para la tarjeta: la base y dónde va el otro valor. */
  monto_base_nota: string;
  montos_fuente_maximo: AvanceMontosFuente;
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
    monto_base_nota:
      base === 'sin_iva'
        ? 'Montos sin IVA (suma de las líneas de la OC; las OC sin subtotal no se suman ni se estiman); el valor con IVA va en una línea chica.'
        : 'Montos con IVA; el valor sin IVA (suma de las líneas de la OC, solo de las que lo traen) va en una línea chica.',
    montos_fuente_maximo: opciones.montos_fuente_maximo,
    reglas: { ...opciones.reglas },
  };
}
