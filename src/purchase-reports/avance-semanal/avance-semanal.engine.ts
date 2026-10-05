import {
  averageAndMedian,
  gestionDays,
} from '../../purchase-dashboard/sap-gestion-days';
import {
  AVANCE_OPCIONES,
  AVANCE_REGLAS,
  type AvanceCorte,
  type AvanceMontoBase,
  type AvanceMontosFuente,
  type AvanceOpciones,
  montoBaseTexto,
  otraBase,
} from './avance-semanal.reglas';

/**
 * H1 (reunión con Ingrid 2026-09-29) — "Reporte de avance semanal": la hoja
 * que Jorge armaba a mano cada viernes, generada por la plataforma (desde el
 * 30-sep la oficial es ésta). Motor ÚNICO de KPIs: recibe los datos ya
 * cargados (avance-semanal.data.ts) y una semana, y devuelve el JSON de la
 * página. El acumulado rebana los mismos datos semana por semana (no repite
 * consultas).
 *
 * K5 (2026-10-05): la página de Maximo con datos reales (estatus, fechas e
 * historial de la PR, K3). Las reglas que esperan respuesta de Ingrid o
 * Jorge viven en avance-semanal.reglas.ts y llegan como parámetro (default =
 * las constantes), para que la conciliación pruebe variantes:
 *  - Gestión = solicitud de compra: solicitud de pedido de SAP o PR de
 *    Maximo. I3: una página de Maximo y una de SAP por semana, homologadas;
 *    `todas` (las dos sumadas) queda solo en la API.
 *  - Recibida (R): SAP = DocDate. Maximo = primer APPR (llegada a Compras)
 *    o ISSUEDATE, según `reglas.recibida`; la PR sin esa fecha no es del
 *    universo y se cuenta aparte (`maximo_no_recibidas`), sin respaldo.
 *  - Por año = por COHORTE: las recibidas en el año y, de esas, cuántas
 *    están cerradas, canceladas o abiertas al corte de la semana.
 *  - Cerrada = primera OC no cancelada (fecha = la OC); sin OC y sin días,
 *    la solicitud de SAP cerrada a mano o la PR cerrada en Maximo (último
 *    CLOSE). Cancelada = SAP cancelada (UpdateDate) o la última CAN del
 *    historial de la PR. Un evento anterior a R cuenta en R. Al corte gana
 *    cerrada, luego cancelada; si no, abierta (en Maximo incluye las que
 *    regresaron a aprobación).
 *  - Días = `gestionDays` (la misma cuenta que G2) con promedio y mediana:
 *    desde la solicitud (SAP) o desde `reglas.dias_desde` (Maximo); un
 *    evento anterior al inicio no entra al promedio ni a la mediana.
 *  - Montos adjudicados = OC no canceladas (estatus actual) por mes de la OC
 *    y por moneda, sin convertir, en la base de AVANCE_MONTO_BASE con el
 *    otro valor aparte; sin subtotal no se estima. Las OC de SAP creadas
 *    desde Maximo son de la gestión de Maximo: cuentan en su página y no en
 *    la de SAP (I3; con `todas`, una vez, D1).
 *  - Semana de lunes a domingo (o de sábado a viernes, `reglas.corte`) con
 *    corte a las 23:59 de México. Las fechas de Maximo traen hora y se
 *    cortan en hora de México (UTC−6: el domingo termina el lunes a las
 *    06:00 UTC y el año empieza el 1-ene a las 06:00 UTC); `doc_date` de SAP
 *    es fecha sin hora y va por día calendario. La etiqueta va de lunes a
 *    viernes, como la de Jorge, y el año de la semana es el de su lunes (la
 *    del 29-dic-2025 es de 2025, como en su archivo).
 */

/** Fuente de UNA página. */
export type AvanceFuente = 'todas' | 'maximo' | 'sap';
export type AvanceSistema = 'sap' | 'maximo';

export const AVANCE_FUENTES: AvanceFuente[] = ['todas', 'maximo', 'sap'];

/**
 * I3: lo que se pide al generar el reporte. `ambos` (default) = una página
 * de Maximo y una de SAP por semana; las demás, una página de esa fuente.
 */
export type AvanceReporte = 'ambos' | AvanceFuente;

export const AVANCE_REPORTES: AvanceReporte[] = [
  'ambos',
  'maximo',
  'sap',
  'todas',
];

/** Fuentes de las páginas de cada semana, en orden (Maximo primero). */
export function fuentesDelReporte(reporte: AvanceReporte): AvanceFuente[] {
  return reporte === 'ambos' ? ['maximo', 'sap'] : [reporte];
}

export const FUENTE_ETIQUETA: Record<AvanceFuente, string> = {
  todas: 'Maximo + SAP',
  maximo: 'Maximo',
  sap: 'SAP',
};

/**
 * Qué fecha es la recibida: la de la solicitud de SAP ('documento') o, en
 * Maximo, el primer APPR o el ISSUEDATE (K5: ya no hay fechas aproximadas).
 */
export type FechaOrigen = 'documento' | 'aprobacion' | 'emision';

export interface Gestion {
  sistema: AvanceSistema;
  /** DocNum de la solicitud de SAP o PRNUM de Maximo. */
  folio: string;
  /** Inicio (R): DocDate de SAP; en Maximo, primer APPR o ISSUEDATE. */
  recibida: Date;
  fecha_origen: FechaOrigen;
  /** Desde dónde cuentan los días (SAP: la recibida); null = sin días. */
  inicio_dias: Date | null;
  /** Fecha de su primera OC no cancelada; null = sin OC. */
  primera_oc: Date | null;
  /** Cierre sin OC: SAP cerrada a mano; PR de Maximo en CLOSE (último). */
  cierre_sin_oc: Date | null;
  /** SAP: UpdateDate de la cancelada; Maximo: última CAN del historial. */
  cancelada: Date | null;
  /** Maximo: la PR tiene contrato (H1: cerradas sin OC ni contrato). */
  de_contrato: boolean;
}

export interface OrdenMonto {
  sistema: AvanceSistema;
  fecha: Date;
  moneda: string | null;
  /** Con IVA (Maximo TOTALCOST, SAP DocTotal), en la moneda del documento. */
  monto: number;
  /**
   * K6: sin IVA = suma de las líneas, en la moneda del documento; null =
   * sin líneas o alguna sin importe (no se estima).
   */
  subtotal: number | null;
  /** OC de SAP creada desde Maximo que existe en Maximo: con `todas` cuenta en Maximo (D1). */
  contada_en_maximo: boolean;
}

/** PR de Maximo fuera del universo: sin la fecha de inicio de la regla. */
export interface MaximoNoRecibida {
  prnum: string;
  /** ISSUEDATE; null = sin fecha de emisión. */
  emision: Date | null;
  pr_status: string | null;
}

export interface AvanceData {
  gestiones: Gestion[];
  ordenes: OrdenMonto[];
  /**
   * K5: con `recibida='aprobacion'`, las PR sin APPR (en aprobación o
   * canceladas sin aprobar); con 'emision', las que no traen ISSUEDATE. Se
   * cuentan aparte, sin respaldo por otra fecha.
   */
  maximo_no_recibidas: MaximoNoRecibida[];
  /** Primera solicitud de SAP (SAP tiene solicitudes desde ene-2026). */
  sap_desde: Date | null;
}

export interface DiasStats {
  promedio_dias: number | null;
  mediana_dias: number | null;
  /** Gestiones con días (eventos anteriores al inicio fuera, como en G2). */
  total: number;
}

export interface ConteoEstados {
  recibidas: number;
  /** Incluye las cerradas sin OC. */
  cerradas: number;
  cerradas_sin_oc: number;
  /**
   * H1 (pregunta a Jorge): PR de Maximo cerradas en Maximo (CLOSE) sin OC
   * ni contrato; ¿para él son cerradas o canceladas?
   */
  cerradas_sin_oc_ni_contrato: number;
  canceladas: number;
  /** Recibidas sin cerrar ni cancelar al corte. */
  abiertas: number;
  /** Cerradas + canceladas (lo que Jorge llama "tratadas" en sus barras). */
  atendidas: number;
  atendidas_pct: number | null;
}

export interface CohorteAnio extends ConteoEstados {
  anio: number;
  dias_cierre: DiasStats;
  dias_cancelacion: DiasStats;
}

export interface SemanaStats {
  lunes: string;
  /** "al 25 de septiembre" (viernes), como Jorge. */
  etiqueta: string;
  nuevas: number;
  cerradas: number;
  /** De esas, las recibidas en años anteriores. */
  cerradas_anteriores: number;
  canceladas: number;
  dias_cierre: DiasStats;
  dias_cancelacion: DiasStats;
}

export interface MontosAnio {
  anio: number;
  /** Base de la tabla (AVANCE_MONTO_BASE). */
  base: AvanceMontoBase;
  /** MXN primero, luego USD y el resto. */
  monedas: string[];
  meses: Array<{
    mes: number;
    etiqueta: string;
    /** En la base; sin la moneda = sin OC con ese valor en el mes. */
    montos: Record<string, number>;
    ordenes: number;
  }>;
  total: Record<string, number>;
  /** OC sumadas en la base. */
  ordenes: number;
  /**
   * El otro valor, por moneda: con IVA de todas las OC, o sin IVA de las
   * que tienen subtotal.
   */
  otro: { base: AvanceMontoBase; total: Record<string, number> };
  /** K6: OC sin subtotal; se cuentan y se dicen, no se estiman. */
  sin_subtotal: { ordenes: number; con_iva: Record<string, number> };
  /** De dónde salen las OC de Maximo; null en la página de SAP. */
  fuente_maximo: AvanceMontosFuente | null;
  /** I3: OC de SAP del año creadas desde Maximo que esta página no suma. */
  migradas_excluidas: number;
}

export interface ResumenSistema {
  recibidas_anio: number;
  nuevas_semana: number;
  cerradas_anio: number;
  cerradas_semana: number;
  dias_cierre: DiasStats;
}

export interface AvancePage {
  semana: {
    lunes: string;
    viernes: string;
    domingo: string;
    anio: number;
    /** "Semana del 21 al 25 de septiembre de 2026". */
    etiqueta: string;
    /** Día del corte ("27 de septiembre de 2026"), 23:59 hora de México. */
    corte: string;
    /** Regla del corte: el domingo o el viernes. */
    corte_dia: AvanceCorte;
  };
  fuente: { clave: AvanceFuente; etiqueta: string };
  /** K5: reglas y bases con las que se armó la página. */
  opciones: AvanceOpciones;
  avance: {
    recibidas_anio: number;
    nuevas_semana: number;
    cerradas_anio: number;
    cerradas_semana: number;
    cerradas_semana_anteriores: number;
    /** Solo en semanas de enero: lo que sigue sin atender del año anterior. */
    anio_anterior: { anio: number; abiertas: number } | null;
    /**
     * K5: PR de Maximo emitidas en el año (al corte) fuera del universo de
     * la regla (con 'aprobacion', las que no se han aprobado); null sin
     * Maximo.
     */
    maximo_no_recibidas: number | null;
  };
  cierre: {
    /** Desde dónde se cuentan los días ("De la solicitud a su primera OC"). */
    nota: string;
    anio: DiasStats;
    semanas: Array<{
      lunes: string;
      etiqueta: string;
      cerradas: number;
      dias: DiasStats;
    }>;
  };
  cancelacion: {
    /** K5: siempre true (Maximo ya trae la CAN del historial de la PR). */
    disponible: boolean;
    nota: string | null;
    anio: DiasStats | null;
    semanas: Array<{
      lunes: string;
      etiqueta: string;
      canceladas: number;
      dias: DiasStats;
    }>;
  };
  /** Dona: estado de las recibidas del año de la semana. */
  estado_anio: ConteoEstados;
  /** Cinco años (barras); los medidores usan los últimos cuatro. */
  anual: CohorteAnio[];
  montos: MontosAnio;
  /** Desglose con `todas` (la página suma los dos). */
  por_sistema: Partial<Record<AvanceSistema, ResumenSistema>>;
  /** Datos que la fuente no manda (K5: ya ninguno de Maximo). */
  no_disponible: Array<{ dato: string; motivo: string }>;
  notas: string[];
  generado: string;
}

/** "aprobación" / "emisión" de la PR, para los textos. */
const INICIO_TEXTO = {
  aprobacion: 'aprobación',
  emision: 'emisión',
} as const;

/**
 * Definiciones de la página (JSON y Excel). I3: cada página habla solo de su
 * sistema; `todas` conserva el texto de las dos. K5: `homologacion` explica
 * en cada página en qué difiere de la otra (SAP se queda con `doc_date`).
 */
export function avanceDefiniciones(
  fuente: AvanceFuente,
  opciones: AvanceOpciones = AVANCE_OPCIONES,
): Record<string, string> {
  const { reglas } = opciones;
  const por = (textos: Record<AvanceFuente, string>) => textos[fuente];
  const aprobacion = reglas.recibida === 'aprobacion';
  const inicioDias = INICIO_TEXTO[reglas.dias_desde];
  const recibidaMaximo = aprobacion
    ? 'primera aprobación de la PR (APPR), cuando llega a Compras; no se mueve si después regresa a aprobación'
    : 'emisión de la PR (ISSUEDATE)';
  const base = montoBaseTexto(opciones.monto_base);
  const baseDetalle =
    opciones.monto_base === 'sin_iva'
      ? 'sin IVA (suma de las líneas de la OC; las OC sin subtotal no se suman ni se estiman)'
      : 'con IVA';
  const otro = montoBaseTexto(otraBase(opciones.monto_base));
  const sapMigradas = opciones.montos_fuente_maximo === 'sap_migradas';
  const corteViernes = reglas.corte === 'viernes';
  const semanaDe = corteViernes ? 'de sábado a viernes' : 'de lunes a domingo';
  const diaCorte = corteViernes ? 'viernes' : 'domingo';
  return {
    gestion: por({
      maximo: 'Gestión = PR de Maximo (solicitud de compra).',
      sap: 'Gestión = solicitud de pedido de SAP.',
      todas:
        'Gestión = solicitud de compra: solicitud de pedido de SAP y PR de Maximo.',
    }),
    recibida: por({
      maximo: aprobacion
        ? `Recibida = ${recibidaMaximo}. Las PR sin aprobación (en aprobación o canceladas sin aprobar) no cuentan como recibidas y se dicen aparte.`
        : `Recibida = ${recibidaMaximo}. Entran todas las PR con fecha de emisión, aprobadas o no.`,
      sap: 'Recibida = fecha de la solicitud de pedido en SAP.',
      todas: `Recibida = fecha de la solicitud de pedido (SAP) o ${recibidaMaximo} (Maximo).${aprobacion ? ' Las PR sin aprobación no cuentan como recibidas.' : ''}`,
    }),
    cohorte:
      'Por año = por cohorte: de las recibidas en el año, cuántas están cerradas, canceladas o abiertas al cierre de la semana.',
    cerrada: por({
      maximo:
        'Cerrada = la PR tiene su primera OC no cancelada (fecha de cierre = la de esa OC) o, sin OC, se cerró en Maximo (último CLOSE; cuenta sin días). Un cierre anterior a la recepción cuenta desde que se recibió.',
      sap: 'Cerrada = la solicitud tiene su primera OC no cancelada; la fecha de cierre es la de esa OC. También cierran, sin días, las solicitudes cerradas a mano sin OC.',
      todas:
        'Cerrada = tiene su primera OC no cancelada; la fecha de cierre es la de esa OC. Sin OC (y sin días) cierran las solicitudes de SAP cerradas a mano y las PR cerradas en Maximo (CLOSE).',
    }),
    cancelada: por({
      maximo:
        'Cancelada = la PR se canceló en Maximo (fecha = la última cancelación, CAN, de su historial). Al corte, una PR cerrada cuenta como cerrada aunque también tenga cancelación.',
      sap: 'Cancelada = solicitud cancelada en SAP (fecha = última actualización de la solicitud).',
      todas:
        'Cancelada = solicitud cancelada en SAP (fecha = su última actualización) o PR cancelada en Maximo (última CAN de su historial).',
    }),
    abierta: por({
      maximo:
        'Abierta = recibida sin cerrar ni cancelar al corte; incluye las PR que regresaron a aprobación.',
      sap: 'Abierta = recibida sin cerrar ni cancelar al corte.',
      todas:
        'Abierta = recibida sin cerrar ni cancelar al corte (en Maximo, incluye las PR que regresaron a aprobación).',
    }),
    dias: por({
      maximo: `Días de cierre y de cancelación = de la ${inicioDias} de la PR a su primera OC o a su cancelación, con promedio y mediana (la misma cuenta que los días de gestión del tablero). Un evento anterior a la ${inicioDias} cuenta en su semana pero no en los días; las cerradas sin OC tampoco tienen días.`,
      sap: 'Días de cierre y de cancelación = de la solicitud a su primera OC o a su cancelación, con promedio y mediana (la misma cuenta que los días de gestión del tablero).',
      todas: `Días de cierre y de cancelación = de la solicitud (SAP) o de la ${inicioDias} de la PR (Maximo) a su primera OC o a su cancelación, con promedio y mediana (la misma cuenta que los días de gestión del tablero).`,
    }),
    montos: por({
      maximo: sapMigradas
        ? `Montos adjudicados = OC de SAP creadas desde Maximo por la integración, no canceladas (estatus actual), ${baseDetalle}, por mes de la OC en SAP y por moneda; USD aparte, sin convertir. El valor ${otro} va aparte.`
        : `Montos adjudicados = OC de Maximo no canceladas (estatus actual), ${baseDetalle}, por mes de creación de la OC y por moneda; USD aparte, sin convertir. Incluye las que la integración pasó a SAP. El valor ${otro} va aparte.`,
      sap: `Montos adjudicados = OC de SAP no canceladas (estatus actual), ${baseDetalle}, por mes de creación de la OC y por moneda; USD aparte, sin convertir. Sin las OC que la integración creó desde Maximo: se cuentan en la página de Maximo. El valor ${otro} va aparte.`,
      todas: `Montos adjudicados = OC no canceladas (estatus actual), ${base}, por mes de creación de la OC y por moneda; USD aparte, sin convertir. Las OC de SAP creadas desde Maximo se cuentan una vez${sapMigradas ? ' (las de Maximo salen de esas OC de SAP)' : ''}. El valor ${otro} va aparte.`,
    }),
    semana: por({
      maximo: `Semana ${semanaDe}, con corte el ${diaCorte} a las 23:59 hora de México (las fechas de Maximo traen hora); la etiqueta va de lunes a viernes, como el reporte de Jorge.`,
      sap: `Semana ${semanaDe} por día calendario (la fecha de la solicitud no trae hora); la etiqueta va de lunes a viernes, como el reporte de Jorge.`,
      todas: `Semana ${semanaDe}: Maximo con corte el ${diaCorte} a las 23:59 hora de México y SAP por día calendario; la etiqueta va de lunes a viernes, como el reporte de Jorge.`,
    }),
    homologacion: por({
      maximo: `Diferencia con la página de SAP: SAP cuenta la solicitud desde su fecha (sin hora, por día calendario) y la cancela con su última actualización; aquí la PR cuenta desde su ${aprobacion ? 'primera aprobación (llegada a Compras)' : 'emisión'}, en hora de México, y se cancela con la CAN de su historial.`,
      sap: `Diferencia con la página de Maximo: Maximo cuenta la PR desde su ${aprobacion ? 'primera aprobación (llegada a Compras)' : 'emisión'}, en hora de México, y la cancela con la CAN de su historial; aquí la solicitud cuenta desde su fecha en SAP, por día calendario.`,
      todas:
        'Cada fuente se suma con su propia definición: SAP por la fecha de la solicitud (día calendario) y Maximo por la de la PR (hora de México).',
    }),
  };
}

// ── Fechas ──────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * México (centro), UTC−6: sin horario de verano desde oct-2022. Antes, en
 * verano era UTC−5; el corte de esas semanas puede correrse una hora, sin
 * efecto en los años (el 1-ene es invierno).
 */
const MX_OFFSET_MS = 6 * HOUR_MS;

/** Maximo trae hora: se corta en hora de México. SAP: día calendario. */
const desfase = (sistema: AvanceSistema) =>
  sistema === 'maximo' ? MX_OFFSET_MS : 0;

/** Días del lunes al fin (exclusivo) de la semana según el corte. */
const DIAS_AL_CORTE: Record<AvanceCorte, number> = { domingo: 7, viernes: 5 };

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

export const MESES_TITULO = MESES.map((m) => m[0].toUpperCase() + m.slice(1));

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** 'YYYY-MM-DD' (o cualquier ISO) → medianoche UTC de ese día. */
export function parseDay(value: string): Date {
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Fecha inválida: ${value}`);
  }
  return date;
}

/** Lunes 00:00 UTC de la semana de `date`. */
export function mondayOf(date: Date): Date {
  const day = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  const offset = (new Date(day).getUTCDay() + 6) % 7;
  return new Date(day - offset * DAY_MS);
}

/** Lunes de la última semana completa (la anterior a la de `now`). */
export function lastCompleteWeek(now = new Date()): Date {
  return new Date(mondayOf(now).getTime() - WEEK_MS);
}

/** Lunes de cada semana de [desde, hasta], del más nuevo al más viejo (como Jorge). */
export function weeksBetween(desde: Date, hasta: Date): Date[] {
  const weeks: Date[] = [];
  const first = mondayOf(desde).getTime();
  for (let t = mondayOf(hasta).getTime(); t >= first; t -= WEEK_MS) {
    weeks.push(new Date(t));
  }
  return weeks;
}

/** Primer lunes del año (el acumulado de Jorge arranca ahí: 5-ene-2026). */
export function firstMondayOfYear(anio: number): Date {
  const jan1 = new Date(Date.UTC(anio, 0, 1));
  const monday = mondayOf(jan1);
  return monday.getTime() < jan1.getTime()
    ? new Date(monday.getTime() + WEEK_MS)
    : monday;
}

/**
 * K5: [inicio, fin) de la semana del `lunes` para las fechas de `sistema`.
 * Con corte el domingo, Maximo va del lunes 06:00 UTC al lunes siguiente
 * 06:00 UTC (00:00 a 23:59 de México) y SAP de lunes a domingo calendario;
 * con corte el viernes, la semana termina el viernes y empieza el sábado
 * anterior.
 */
export function ventanaSemana(
  lunes: Date,
  sistema: AvanceSistema,
  corte: AvanceCorte = AVANCE_REGLAS.corte,
): { inicio: number; fin: number } {
  const fin =
    mondayOf(lunes).getTime() +
    DIAS_AL_CORTE[corte] * DAY_MS +
    desfase(sistema);
  return { inicio: fin - WEEK_MS, fin };
}

/** Año de una fecha del sistema (Maximo en hora de México: desde el 1-ene 06:00 UTC). */
export function anioDe(fecha: Date, sistema: AvanceSistema): number {
  return new Date(fecha.getTime() - desfase(sistema)).getUTCFullYear();
}

/** Mes (0-11) de una fecha del sistema, con la misma regla que `anioDe`. */
function mesDe(fecha: Date, sistema: AvanceSistema): number {
  return new Date(fecha.getTime() - desfase(sistema)).getUTCMonth();
}

/** Fin (exclusivo) de la semana para cada sistema. */
function finesDeSemana(
  lunes: Date,
  corte: AvanceCorte,
): Record<AvanceSistema, number> {
  return {
    sap: ventanaSemana(lunes, 'sap', corte).fin,
    maximo: ventanaSemana(lunes, 'maximo', corte).fin,
  };
}

const addDays = (d: Date, days: number) =>
  new Date(d.getTime() + days * DAY_MS);

/** "21 de septiembre de 2026". */
export function fechaLarga(d: Date): string {
  return `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

/** "Semana del 21 al 25 de septiembre de 2026" (lunes a viernes). */
export function etiquetaSemana(lunes: Date): string {
  const viernes = addDays(lunes, 4);
  const d1 = lunes.getUTCDate();
  const d2 = viernes.getUTCDate();
  const [m1, m2] = [lunes.getUTCMonth(), viernes.getUTCMonth()];
  const [y1, y2] = [lunes.getUTCFullYear(), viernes.getUTCFullYear()];
  if (y1 !== y2) {
    return `Semana del ${d1} de ${MESES[m1]} de ${y1} al ${d2} de ${MESES[m2]} de ${y2}`;
  }
  if (m1 !== m2) {
    return `Semana del ${d1} de ${MESES[m1]} al ${d2} de ${MESES[m2]} de ${y2}`;
  }
  return `Semana del ${d1} al ${d2} de ${MESES[m2]} de ${y2}`;
}

/** "al 25 de septiembre" (el viernes de la semana), como las viñetas de Jorge. */
function alViernes(lunes: Date): string {
  const viernes = addDays(lunes, 4);
  return `al ${viernes.getUTCDate()} de ${MESES[viernes.getUTCMonth()]}`;
}

// ── Estados ─────────────────────────────────────────────────────────────

type Estado = 'cerrada' | 'cancelada' | 'abierta';

interface EstadoAl {
  estado: Estado;
  /** Momento del cierre o la cancelación; null si sigue abierta. */
  fecha: number | null;
  con_oc: boolean;
}

/**
 * Estado de la gestión al corte `fin` (exclusivo): cerrada si el cierre es
 * anterior; si no, cancelada si la cancelación es anterior; si no, abierta.
 * Un evento fechado antes que la recibida (captura retroactiva, OC anterior
 * a la aprobación) cuenta desde que se recibió: greatest(evento, R).
 */
export function estadoAl(g: Gestion, fin: number): EstadoAl {
  const recibida = g.recibida.getTime();
  const at = (d: Date | null) =>
    d === null ? null : Math.max(d.getTime(), recibida);
  const oc = at(g.primera_oc);
  if (oc !== null && oc < fin) {
    return { estado: 'cerrada', fecha: oc, con_oc: true };
  }
  const sinOc = at(g.cierre_sin_oc);
  if (sinOc !== null && sinOc < fin) {
    return { estado: 'cerrada', fecha: sinOc, con_oc: false };
  }
  const cancel = at(g.cancelada);
  if (cancel !== null && cancel < fin) {
    return { estado: 'cancelada', fecha: cancel, con_oc: false };
  }
  return { estado: 'abierta', fecha: null, con_oc: false };
}

/**
 * Días de la gestión hasta `evento` desde su inicio de días; null = sin
 * inicio o evento anterior al inicio (fuera del promedio y la mediana).
 */
function diasHasta(g: Gestion, evento: Date | null): number | null {
  if (!evento || !g.inicio_dias) return null;
  return gestionDays(g.inicio_dias, evento);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function diasStats(values: number[]): DiasStats {
  return { ...averageAndMedian(values), total: values.length };
}

function conteoVacio(): ConteoEstados {
  return {
    recibidas: 0,
    cerradas: 0,
    cerradas_sin_oc: 0,
    cerradas_sin_oc_ni_contrato: 0,
    canceladas: 0,
    abiertas: 0,
    atendidas: 0,
    atendidas_pct: null,
  };
}

function cerrarConteo(c: ConteoEstados): ConteoEstados {
  const atendidas = c.cerradas + c.canceladas;
  return {
    ...c,
    atendidas,
    atendidas_pct:
      c.recibidas === 0 ? null : round1((atendidas / c.recibidas) * 100),
  };
}

/** Cohortes de varios años al corte de la semana del `lunes`, en una sola pasada. */
export function cohortes(
  gestiones: Gestion[],
  anios: number[],
  lunes: Date,
  corte: AvanceCorte = AVANCE_REGLAS.corte,
): CohorteAnio[] {
  const fines = finesDeSemana(lunes, corte);
  const acc = new Map(
    anios.map((anio) => [
      anio,
      { conteo: conteoVacio(), cierre: [] as number[], cancel: [] as number[] },
    ]),
  );
  for (const g of gestiones) {
    const fin = fines[g.sistema];
    if (g.recibida.getTime() >= fin) continue;
    const entry = acc.get(anioDe(g.recibida, g.sistema));
    if (!entry) continue;
    const c = entry.conteo;
    c.recibidas += 1;
    const e = estadoAl(g, fin);
    if (e.estado === 'cerrada') {
      c.cerradas += 1;
      if (!e.con_oc) {
        c.cerradas_sin_oc += 1;
        if (g.sistema === 'maximo' && !g.de_contrato) {
          c.cerradas_sin_oc_ni_contrato += 1;
        }
      } else {
        const days = diasHasta(g, g.primera_oc);
        if (days !== null) entry.cierre.push(days);
      }
    } else if (e.estado === 'cancelada') {
      c.canceladas += 1;
      const days = diasHasta(g, g.cancelada);
      if (days !== null) entry.cancel.push(days);
    } else {
      c.abiertas += 1;
    }
  }
  return anios.map((anio) => {
    const entry = acc.get(anio)!;
    return {
      anio,
      ...cerrarConteo(entry.conteo),
      dias_cierre: diasStats(entry.cierre),
      dias_cancelacion: diasStats(entry.cancel),
    };
  });
}

/** Lo que pasó en la semana del `lunes` (recibidas, cierres y cancelaciones). */
export function semanaStats(
  gestiones: Gestion[],
  lunes: Date,
  corte: AvanceCorte = AVANCE_REGLAS.corte,
): SemanaStats {
  const semanaInicio = mondayOf(lunes);
  const ventanas = {
    sap: ventanaSemana(semanaInicio, 'sap', corte),
    maximo: ventanaSemana(semanaInicio, 'maximo', corte),
  };
  const anio = semanaInicio.getUTCFullYear();
  let nuevas = 0;
  let cerradas = 0;
  let anteriores = 0;
  let canceladas = 0;
  const cierre: number[] = [];
  const cancel: number[] = [];
  for (const g of gestiones) {
    const { inicio, fin } = ventanas[g.sistema];
    const recibida = g.recibida.getTime();
    if (recibida >= inicio && recibida < fin) nuevas += 1;
    if (recibida >= fin) continue;
    const e = estadoAl(g, fin);
    if (e.fecha === null || e.fecha < inicio) continue;
    if (e.estado === 'cerrada') {
      cerradas += 1;
      if (anioDe(g.recibida, g.sistema) < anio) anteriores += 1;
      if (e.con_oc) {
        const days = diasHasta(g, g.primera_oc);
        if (days !== null) cierre.push(days);
      }
    } else if (e.estado === 'cancelada') {
      canceladas += 1;
      const days = diasHasta(g, g.cancelada);
      if (days !== null) cancel.push(days);
    }
  }
  return {
    lunes: isoDay(semanaInicio),
    etiqueta: alViernes(semanaInicio),
    nuevas,
    cerradas,
    cerradas_anteriores: anteriores,
    canceladas,
    dias_cierre: diasStats(cierre),
    dias_cancelacion: diasStats(cancel),
  };
}

// ── Montos ──────────────────────────────────────────────────────────────

const enFuente = (sistema: AvanceSistema, fuente: AvanceFuente) =>
  fuente === 'todas' || fuente === sistema;

const SIN_MONEDA = 'Sin moneda';

function ordenMonedas(monedas: Iterable<string>): string[] {
  const rank = (m: string) => (m === 'MXN' ? 0 : m === 'USD' ? 1 : 2);
  return [...new Set(monedas)].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
}

/**
 * OC que suma la página. I3/D1: la OC de SAP creada desde Maximo es de la
 * gestión de Maximo (nunca en la de SAP). Con `sap_migradas`, Maximo toma
 * esas OC de SAP en lugar de las suyas.
 */
function ordenDeLaPagina(
  o: OrdenMonto,
  fuente: AvanceFuente,
  montosFuente: AvanceMontosFuente,
): boolean {
  const deMaximo =
    montosFuente === 'sap_migradas'
      ? o.sistema === 'sap' && o.contada_en_maximo
      : o.sistema === 'maximo';
  const deSap = o.sistema === 'sap' && !o.contada_en_maximo;
  if (fuente === 'maximo') return deMaximo;
  if (fuente === 'sap') return deSap;
  return deMaximo || deSap;
}

const sumar = (acc: Record<string, number>, moneda: string, valor: number) => {
  acc[moneda] = round2((acc[moneda] ?? 0) + valor);
};

/**
 * OC del año por mes de creación y por moneda, hasta el corte de la semana
 * del `lunes`, en la base de `opciones.monto_base` (K5/K6). El otro valor
 * va por moneda en `otro`; las OC sin subtotal se cuentan en `sin_subtotal`
 * y no se estiman (con base sin IVA no se suman).
 */
export function montosAdjudicados(
  ordenes: OrdenMonto[],
  fuente: AvanceFuente,
  anio: number,
  lunes: Date,
  opciones: AvanceOpciones = AVANCE_OPCIONES,
): MontosAnio {
  const base = opciones.monto_base;
  const fines = finesDeSemana(lunes, opciones.reglas.corte);
  // Último día de la semana (calendario): hasta su mes
  const ultimoDia = new Date(fines.sap - 1);
  const ultimoMes =
    ultimoDia.getUTCFullYear() > anio ? 11 : ultimoDia.getUTCMonth();
  const meses = MESES_TITULO.slice(0, ultimoMes + 1).map((etiqueta, i) => ({
    mes: i + 1,
    etiqueta,
    montos: {} as Record<string, number>,
    ordenes: 0,
  }));
  const total: Record<string, number> = {};
  const otroTotal: Record<string, number> = {};
  const sinSubtotal = { ordenes: 0, con_iva: {} as Record<string, number> };
  let count = 0;
  let migradas = 0;
  for (const o of ordenes) {
    if (
      anioDe(o.fecha, o.sistema) !== anio ||
      o.fecha.getTime() >= fines[o.sistema]
    ) {
      continue;
    }
    if (!ordenDeLaPagina(o, fuente, opciones.montos_fuente_maximo)) {
      // I3: la OC de SAP creada desde Maximo es de la gestión de Maximo
      if (fuente === 'sap' && o.contada_en_maximo) migradas += 1;
      continue;
    }
    const mes = meses[mesDe(o.fecha, o.sistema)];
    if (!mes) continue;
    const moneda = o.moneda ?? SIN_MONEDA;
    const valor = base === 'sin_iva' ? o.subtotal : o.monto;
    const otro = base === 'sin_iva' ? o.monto : o.subtotal;
    if (o.subtotal === null) {
      sinSubtotal.ordenes += 1;
      sumar(sinSubtotal.con_iva, moneda, o.monto);
    }
    if (valor !== null) {
      sumar(mes.montos, moneda, valor);
      mes.ordenes += 1;
      sumar(total, moneda, valor);
      count += 1;
    }
    if (otro !== null) sumar(otroTotal, moneda, otro);
  }
  return {
    anio,
    base,
    monedas: ordenMonedas([...Object.keys(total), ...Object.keys(otroTotal)]),
    meses,
    total,
    ordenes: count,
    otro: { base: otraBase(base), total: otroTotal },
    sin_subtotal: sinSubtotal,
    fuente_maximo: fuente === 'sap' ? null : opciones.montos_fuente_maximo,
    migradas_excluidas: migradas,
  };
}

// ── Página ──────────────────────────────────────────────────────────────

const fmtCount = (n: number) => n.toLocaleString('es-MX');

const plural = (n: number, uno: string, varios: string) =>
  `${fmtCount(n)} ${n === 1 ? uno : varios}`;

/** Subtítulos de las tarjetas de días según la fuente y la regla. */
function notasDias(
  fuente: AvanceFuente,
  opciones: AvanceOpciones,
): { cierre: string; cancelacion: string } {
  const pr = `la ${INICIO_TEXTO[opciones.reglas.dias_desde]} de la PR`;
  const desde =
    fuente === 'sap'
      ? 'la solicitud'
      : fuente === 'maximo'
        ? pr
        : `la solicitud (SAP) o ${pr} (Maximo)`;
  return {
    cierre: `De ${desde} a su primera OC`,
    cancelacion: `De ${desde} a su cancelación`,
  };
}

export function buildAvancePage(
  data: AvanceData,
  lunes: Date,
  fuente: AvanceFuente,
  generado: Date,
  opciones: AvanceOpciones = AVANCE_OPCIONES,
): AvancePage {
  const { corte } = opciones.reglas;
  const semanaInicio = mondayOf(lunes);
  const start = semanaInicio.getTime();
  const anio = semanaInicio.getUTCFullYear();
  const gestiones = data.gestiones.filter((g) => enFuente(g.sistema, fuente));

  const anios = [anio - 4, anio - 3, anio - 2, anio - 1, anio];
  const anual = cohortes(gestiones, anios, semanaInicio, corte);
  const actual = anual[anual.length - 1];
  const previo = anual[anual.length - 2];
  const semana = semanaStats(gestiones, semanaInicio, corte);
  const ultimas = [3, 2, 1, 0].map((k) =>
    k === 0
      ? semana
      : semanaStats(gestiones, new Date(start - k * WEEK_MS), corte),
  );

  const conSap = fuente !== 'maximo';
  const conMaximo = fuente !== 'sap';
  const dias = notasDias(fuente, opciones);

  const porSistema: AvancePage['por_sistema'] = {};
  if (fuente === 'todas') {
    for (const sistema of ['sap', 'maximo'] as const) {
      const propias = gestiones.filter((g) => g.sistema === sistema);
      const [cohorte] = cohortes(propias, [anio], semanaInicio, corte);
      const sem = semanaStats(propias, semanaInicio, corte);
      porSistema[sistema] = {
        recibidas_anio: cohorte.recibidas,
        nuevas_semana: sem.nuevas,
        cerradas_anio: cohorte.cerradas,
        cerradas_semana: sem.cerradas,
        dias_cierre: cohorte.dias_cierre,
      };
    }
  }

  // K5: PR de Maximo emitidas en el año (al corte) que no entran al universo
  const finMaximo = ventanaSemana(semanaInicio, 'maximo', corte).fin;
  const noRecibidas = conMaximo
    ? data.maximo_no_recibidas.filter(
        (p) =>
          p.emision !== null &&
          p.emision.getTime() < finMaximo &&
          anioDe(p.emision, 'maximo') === anio,
      ).length
    : null;

  const montos = montosAdjudicados(
    data.ordenes,
    fuente,
    anio,
    semanaInicio,
    opciones,
  );

  const notas: string[] = [];
  if (noRecibidas) {
    notas.push(
      noRecibidas === 1
        ? `1 PR de Maximo emitida en ${anio} no se ha aprobado (en aprobación o cancelada sin aprobar): no llegó a Compras y no cuenta como recibida.`
        : `${fmtCount(noRecibidas)} PR de Maximo emitidas en ${anio} no se han aprobado (en aprobación o canceladas sin aprobar): no llegaron a Compras y no cuentan como recibidas.`,
    );
  }
  notas.push(
    `Montos ${montoBaseTexto(opciones.monto_base)}${opciones.monto_base === 'sin_iva' ? ' (suma de las líneas de la OC)' : ''} por mes de creación de la OC; OC no canceladas; cada moneda aparte, sin convertir.`,
  );
  if (conMaximo && montos.fuente_maximo === 'sap_migradas') {
    notas.push(
      'Los montos de Maximo salen de las OC de SAP que la integración creó desde Maximo (fecha de la OC en SAP).',
    );
  }
  if (montos.sin_subtotal.ordenes > 0) {
    const n = montos.sin_subtotal.ordenes;
    const verbo = n === 1 ? 'entra' : 'entran';
    notas.push(
      `${fmtCount(n)} OC sin subtotal (sin líneas o alguna sin importe) no ${verbo} ${
        opciones.monto_base === 'sin_iva'
          ? 'a los montos sin IVA'
          : 'al valor sin IVA'
      }: no se estima${n === 1 ? '' : 'n'}.`,
    );
  }
  if (fuente === 'todas') {
    notas.push(
      'Las OC de SAP creadas desde Maximo se cuentan una vez (en Maximo), igual que en el tablero.',
    );
  }
  if (montos.migradas_excluidas === 1) {
    notas.push(
      `1 OC de SAP creada desde Maximo en ${anio} no se suma aquí: es de la gestión de Maximo y se cuenta en su página.`,
    );
  } else if (montos.migradas_excluidas > 1) {
    notas.push(
      `${fmtCount(montos.migradas_excluidas)} OC de SAP creadas desde Maximo en ${anio} no se suman aquí: son de la gestión de Maximo y se cuentan en su página.`,
    );
  }
  if (actual.cerradas_sin_oc > 0) {
    // desglose por sistema: SAP cerrada a mano / PR cerrada en Maximo
    const fines = finesDeSemana(semanaInicio, corte);
    const sinOc = { sap: 0, maximo: 0 };
    for (const g of gestiones) {
      const fin = fines[g.sistema];
      if (anioDe(g.recibida, g.sistema) !== anio) continue;
      if (g.recibida.getTime() >= fin) continue;
      const e = estadoAl(g, fin);
      if (e.estado === 'cerrada' && !e.con_oc) sinOc[g.sistema] += 1;
    }
    const sinContrato = actual.cerradas_sin_oc_ni_contrato;
    const partes = [
      sinOc.sap > 0
        ? `${plural(sinOc.sap, 'solicitud de SAP cerrada', 'solicitudes de SAP cerradas')} a mano sin OC`
        : null,
      sinOc.maximo > 0
        ? `${plural(sinOc.maximo, 'PR cerrada', 'PR cerradas')} en Maximo sin OC${
            sinContrato > 0 ? ` (${fmtCount(sinContrato)} sin contrato)` : ''
          }`
        : null,
    ].filter(Boolean);
    notas.push(
      `${partes.join(' y ')}: ${
        sinOc.sap + sinOc.maximo === 1
          ? 'cuenta como cerrada'
          : 'cuentan como cerradas'
      }, sin días.`,
    );
  }
  if (conSap && data.sap_desde && data.sap_desde.getUTCFullYear() > anios[0]) {
    notas.push(
      fuente === 'sap'
        ? `SAP tiene solicitudes desde el ${fechaLarga(data.sap_desde)}; los años anteriores salen en cero.`
        : `SAP tiene solicitudes desde el ${fechaLarga(data.sap_desde)}; los años anteriores son solo de Maximo.`,
    );
  }
  if (semana.cerradas_anteriores > 0) {
    notas.push(
      `De las ${fmtCount(semana.cerradas)} cerradas en la semana, ${fmtCount(semana.cerradas_anteriores)} se recibieron antes de ${anio}.`,
    );
  }

  const domingo = addDays(semanaInicio, 6);
  const diaCorte = addDays(semanaInicio, DIAS_AL_CORTE[corte] - 1);
  return {
    semana: {
      lunes: isoDay(semanaInicio),
      viernes: isoDay(addDays(semanaInicio, 4)),
      domingo: isoDay(domingo),
      anio,
      etiqueta: etiquetaSemana(semanaInicio),
      corte: fechaLarga(diaCorte),
      corte_dia: corte,
    },
    fuente: { clave: fuente, etiqueta: FUENTE_ETIQUETA[fuente] },
    opciones,
    avance: {
      recibidas_anio: actual.recibidas,
      nuevas_semana: semana.nuevas,
      cerradas_anio: actual.cerradas,
      cerradas_semana: semana.cerradas,
      cerradas_semana_anteriores: semana.cerradas_anteriores,
      anio_anterior:
        semanaInicio.getUTCMonth() === 0
          ? { anio: anio - 1, abiertas: previo.abiertas }
          : null,
      maximo_no_recibidas: noRecibidas,
    },
    cierre: {
      nota: dias.cierre,
      anio: actual.dias_cierre,
      semanas: ultimas.map((s) => ({
        lunes: s.lunes,
        etiqueta: s.etiqueta,
        cerradas: s.cerradas,
        dias: s.dias_cierre,
      })),
    },
    cancelacion: {
      disponible: true,
      nota: dias.cancelacion,
      anio: actual.dias_cancelacion,
      semanas: ultimas.map((s) => ({
        lunes: s.lunes,
        etiqueta: s.etiqueta,
        canceladas: s.canceladas,
        dias: s.dias_cancelacion,
      })),
    },
    estado_anio: {
      recibidas: actual.recibidas,
      cerradas: actual.cerradas,
      cerradas_sin_oc: actual.cerradas_sin_oc,
      cerradas_sin_oc_ni_contrato: actual.cerradas_sin_oc_ni_contrato,
      canceladas: actual.canceladas,
      abiertas: actual.abiertas,
      atendidas: actual.atendidas,
      atendidas_pct: actual.atendidas_pct,
    },
    anual,
    montos,
    por_sistema: porSistema,
    no_disponible: [],
    notas,
    generado: generado.toISOString(),
  };
}
