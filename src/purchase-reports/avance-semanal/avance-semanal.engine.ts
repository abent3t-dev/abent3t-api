import {
  averageAndMedian,
  gestionDays,
} from '../../purchase-dashboard/sap-gestion-days';
import {
  AVANCE_GRUPOS_MAXIMO,
  AVANCE_OPCIONES,
  AVANCE_REGLAS,
  type AvanceCorte,
  type AvanceDiasTipo,
  type AvanceGrupos,
  type AvanceMontoBase,
  type AvanceMontosFuente,
  type AvanceOpciones,
  type AvancePromedioTitulo,
  type AvanceTipoCambio,
  diasTexto,
  montoBaseTexto,
  otraBase,
  tipoCambioTexto,
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
 *    evento anterior al inicio no entra al promedio ni a la mediana. H3:
 *    con `reglas.dias_tipo='habiles'`, `diasHabiles` cuenta solo el tiempo
 *    que cae de lunes a viernes sin festivos (`holidays`), en las dos
 *    páginas y con fracción, en la hora local de cada sistema.
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
 *
 * L2 (2026-10-08, vista previa): con `grupos='contrato'` la página de Maximo
 * trae además `grupos`: las recibidas en cuatro grupos (cerradas sin
 * contrato, de contrato, canceladas en Maximo y abiertas) para la dona, los
 * medidores y las barras. Los KPIs no cambian; sin el parámetro (default
 * AVANCE_GRUPOS_MAXIMO = 'estandar') la página es la de siempre.
 *
 * O1 (2026-10-26, Jorge y datos de CIISA): corte el viernes, días hábiles y
 * montos con IVA por default (avance-semanal.reglas.ts). En la página de
 * Maximo los montos son los del reporte de Compras: sin las OC de contrato
 * (CONTRACTREFNUM) y con dólares y euros pasados a pesos (`tipoDeCambio`);
 * solo aquí, Órdenes y el resto de Compras no cambian. La página de Maximo
 * lleva la leyenda de las recibidas (PR aprobadas, aproximación de las RQ
 * hasta O2) y las tarjetas de días un `titulo` con el promedio del año o de
 * la semana (`opciones.promedio_titulo`).
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
  /**
   * H6 (2026-10-05), solo Maximo: ISSUEDATE de la PR. Con 'aprobacion', la
   * PR emitida antes del corte y aprobada después no había llegado a Compras
   * en esa semana: cuenta en `maximo_no_recibidas` de la página.
   */
  emision?: Date | null;
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
  /**
   * Solo SAP: copia extra de la misma PO de Maximo (la integración a veces
   * crea varias OC con el mismo NumAtCard; vale la de menor DocNum). Con
   * `sap_migradas` la página de Maximo la ignora para contar la PO una vez
   * (D1). Ausente = false.
   */
  copia_migrada?: boolean;
  /**
   * O1: OC de contrato (CONTRACTREFNUM en su registro de Maximo; en SAP, el
   * de su OC de Maximo). La página de Maximo no la suma. Ausente = false.
   */
  de_contrato?: boolean;
  /** O1: EXCHANGERATE de la OC de Maximo, contra el dólar. */
  tc_usd?: number | null;
}

/** O1: monedas que la página de Maximo pasa a pesos. */
export const MONEDAS_CONVERTIBLES = ['USD', 'EUR'];

/** O1: tipos de cambio para pasar a pesos las OC de Maximo (avance-semanal.data). */
export interface TiposCambio {
  /**
   * Pesos por dólar de cada día de Maximo ('YYYY-MM-DD', hora de México),
   * ascendente: 1 / el EXCHANGERATE de sus OC en pesos.
   */
  maximo_dia: Array<{ dia: string; mxn_por_usd: number }>;
  /**
   * Pesos por unidad de cada moneda por mes ('USD|2026-03'): el de
   * referencia de SAP (promedio de DocTotal / DocTotalFc de sus OC).
   */
  sap_mes: Record<string, number>;
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
  /**
   * H3: festivos activos de la tabla `holidays` ('YYYY-MM-DD'), para los
   * días hábiles. Ausente o vacío = hábiles solo quita sábados y domingos.
   */
  festivos?: string[];
  /** O1: tipos de cambio; ausente = ninguna OC se convierte. */
  tipos_cambio?: TiposCambio;
}

/** H3: cómo se cuentan los días (tipo y festivos de los hábiles). */
export interface CuentaDias {
  tipo: AvanceDiasTipo;
  /** 'YYYY-MM-DD'; solo cuentan con `tipo='habiles'`. */
  festivos: readonly string[];
}

/** Default de `cohortes` y `semanaStats`: días naturales (sin festivos). */
export const DIAS_NATURALES: CuentaDias = { tipo: 'naturales', festivos: [] };

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
  /**
   * H2 (calibración del 5-oct): PR de Maximo de contrato cerradas al corte
   * (con OC o por CLOSE). Al 5-oct son 126, lo mismo que las "canceladas"
   * de Jorge: ¿eso cuenta él como cancelada? En SAP, 0.
   */
  cerradas_de_contrato: number;
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

/**
 * L2: grupos de las recibidas con `grupos='contrato'` (clave estable). Las
 * cerradas del KPI = cerradas_sin_contrato + de_contrato.
 */
export type GrupoClave =
  | 'cerradas_sin_contrato'
  | 'de_contrato'
  | 'canceladas'
  | 'abiertas';

export interface GrupoEstado {
  clave: GrupoClave;
  /**
   * "Cerradas sin contrato", "De contrato (OC automática)", "Canceladas en
   * Maximo" o "Abiertas".
   */
  etiqueta: string;
  valor: number;
  /** % de las recibidas, con un decimal; null sin recibidas. */
  pct: number | null;
}

export interface GruposConteo {
  recibidas: number;
  /**
   * En este orden: cerradas_sin_contrato, de_contrato, canceladas,
   * abiertas; suman las recibidas.
   */
  grupos: GrupoEstado[];
}

/**
 * L2 (vista previa): la página de Maximo con `grupos='contrato'`. Sin esa
 * opción la página no trae este bloque (y el JSON queda como antes).
 */
export interface AvanceGruposPagina {
  modo: 'contrato';
  /** Dona: las recibidas del año de la semana. */
  estado_anio: GruposConteo;
  /** Los años de `anual`, en el mismo orden (medidores y barras). */
  anual: Array<GruposConteo & { anio: number }>;
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
    /**
     * H9 (2026-10-05): OC del mes sin subtotal, por moneda. Con base sin
     * IVA distingue "sin compras" (sin la moneda aquí) de "con compras sin
     * subtotal" (No disponible, nunca $0).
     */
    sin_subtotal: Record<string, number>;
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
  /** O1: qué OC suma la tabla, en una frase (subtítulo del PDF y Excel). */
  descripcion: string;
  /** O1: lo que se hizo con las OC de Maximo; null en la página de SAP. */
  maximo: MontosMaximo | null;
}

/** O1: las OC de Maximo de la página (las de contrato y las convertidas). */
export interface MontosMaximo {
  tipo_cambio: AvanceTipoCambio;
  /** OC de contrato del año (CONTRACTREFNUM): no se suman; con IVA por moneda. */
  contrato: { ordenes: number; con_iva: Record<string, number> };
  /**
   * OC en dólares o euros pasadas a pesos, por moneda: cuántas, su monto con
   * IVA en su moneda y en pesos.
   */
  convertidas: Record<
    string,
    { ordenes: number; original: number; mxn: number }
  >;
  /** De esas, con el tipo de referencia de SAP del mes (sin tipo de Maximo). */
  con_referencia: number;
  /** En dólares o euros sin ningún tipo de cambio: quedan en su moneda. */
  sin_tipo_cambio: number;
}

/** O1.3: el promedio grande de una tarjeta de días: del año o de la semana. */
export interface TituloDias {
  promedio: AvancePromedioTitulo;
  dias: DiasStats | null;
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
     * la regla (con 'aprobacion', las que no se habían aprobado al corte,
     * H6: también las aprobadas después); null sin Maximo.
     */
    maximo_no_recibidas: number | null;
    /**
     * O1.4: solo la página de Maximo, hasta O2: qué cuenta como recibida y
     * que el reporte de Compras cuenta RQ. null en las demás.
     */
    leyenda: string | null;
  };
  cierre: {
    /** Desde dónde se cuentan los días ("De la solicitud a su primera OC"). */
    nota: string;
    /** H3: "días" o "días hábiles" (`reglas.dias_tipo`), para los textos. */
    unidad: string;
    anio: DiasStats;
    /** O1.3: el promedio del título (`opciones.promedio_titulo`). */
    titulo: TituloDias;
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
    /** H3: "días" o "días hábiles", como en `cierre`. */
    unidad: string;
    anio: DiasStats | null;
    /** O1.3: el promedio del título, como en `cierre`. */
    titulo: TituloDias;
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
  /**
   * L2 (vista previa): solo en la página de Maximo con `grupos='contrato'`;
   * ausente = cerradas · canceladas · abiertas, como siempre.
   */
  grupos?: AvanceGruposPagina;
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
 * L2: nombre de cada grupo con `grupos='contrato'` (JSON, PDF, Excel,
 * notas y definiciones). Las PR de contrato NO se llaman "canceladas", y las
 * cerradas del grupo dicen "sin contrato" para no confundirse con el KPI de
 * cerradas (que incluye las de contrato).
 */
export const GRUPOS_ETIQUETA: Record<GrupoClave, string> = {
  cerradas_sin_contrato: 'Cerradas sin contrato',
  de_contrato: 'De contrato (OC automática)',
  canceladas: 'Canceladas en Maximo',
  abiertas: 'Abiertas',
};

/** L2: el nombre del grupo dentro de una frase ("cerradas sin contrato"). */
export function grupoEnFrase(clave: GrupoClave): string {
  const etiqueta = GRUPOS_ETIQUETA[clave];
  return etiqueta.charAt(0).toLowerCase() + etiqueta.slice(1);
}

/**
 * Definiciones de la página (JSON y Excel). I3: cada página habla solo de su
 * sistema; `todas` conserva el texto de las dos. K5: `homologacion` explica
 * en cada página en qué difiere de la otra (SAP se queda con `doc_date`).
 * L2: con `grupos='contrato'`, la de Maximo explica sus grupos (`grupos`).
 */
export function avanceDefiniciones(
  fuente: AvanceFuente,
  opciones: AvanceOpciones = AVANCE_OPCIONES,
  grupos: AvanceGrupos = AVANCE_GRUPOS_MAXIMO,
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
  // O1: lo que solo hace la página de Maximo con sus OC
  const sinContrato =
    'que no son de contrato (CONTRACTREFNUM en la cabecera o en una línea)';
  const aPesos =
    opciones.tipo_cambio === 'maximo'
      ? 'las de dólares y euros pasadas a pesos con el tipo de cambio de Maximo del día (EXCHANGERATE va contra el dólar: pesos por dólar = 1 / el de las OC en pesos de ese día o del anterior más cercano que lo tenga; en euros, además × el de la OC); sin tipo del día, con el de referencia de SAP del mes (DocTotal / DocTotalFc)'
      : 'las de dólares y euros pasadas a pesos con el tipo de cambio de referencia de SAP del mes (promedio de DocTotal / DocTotalFc de sus OC)';
  const soloAqui =
    'Solo en este reporte: Órdenes, CAPEX/OPEX y el resto de Compras no quitan las OC de contrato ni convierten monedas.';
  const corteViernes = reglas.corte === 'viernes';
  const semanaDe = corteViernes ? 'de sábado a viernes' : 'de lunes a domingo';
  const diaCorte = corteViernes ? 'viernes' : 'domingo';
  // H3: días naturales o hábiles, igual en las dos páginas (homologadas)
  const habiles = reglas.dias_tipo === 'habiles';
  const diasTitulo = habiles ? 'Días hábiles' : 'Días';
  const cuentaDias = (hora: string) =>
    habiles
      ? `. Días hábiles = solo el tiempo que cae de lunes a viernes (${hora}), sin los festivos activos de la tabla de días festivos (holidays) si los hay; con fracción de día, como los naturales`
      : ' (la misma cuenta que los días de gestión del tablero)';
  const diasIguales = (en: string) =>
    `Los días de cierre y de cancelación se cuentan igual en ${en}: ${
      habiles ? 'hábiles (de lunes a viernes, sin festivos)' : 'naturales'
    }.`;
  const definiciones: Record<string, string> = {
    gestion: por({
      maximo: 'Gestión = PR de Maximo (solicitud de compra).',
      sap: 'Gestión = solicitud de pedido de SAP.',
      todas:
        'Gestión = solicitud de compra: solicitud de pedido de SAP y PR de Maximo.',
    }),
    recibida: por({
      maximo: `${
        aprobacion
          ? `Recibida = ${recibidaMaximo}. Las PR sin aprobación (en aprobación o canceladas sin aprobar) no cuentan como recibidas y se dicen aparte.`
          : `Recibida = ${recibidaMaximo}. Entran todas las PR con fecha de emisión, aprobadas o no.`
      } Es una aproximación: el reporte de Compras cuenta solicitudes de cotización (RQ), y una PR solo llega a RQ cuando ya está aprobada.`,
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
      maximo: `${diasTitulo} de cierre y de cancelación = de la ${inicioDias} de la PR a su primera OC o a su cancelación, con promedio y mediana${cuentaDias('en hora de México')}. Un evento anterior a la ${inicioDias} cuenta en su semana pero no en los días; las cerradas sin OC tampoco tienen días.`,
      sap: `${diasTitulo} de cierre y de cancelación = de la solicitud a su primera OC o a su cancelación, con promedio y mediana${cuentaDias('por día calendario')}.`,
      todas: `${diasTitulo} de cierre y de cancelación = de la solicitud (SAP) o de la ${inicioDias} de la PR (Maximo) a su primera OC o a su cancelación, con promedio y mediana${cuentaDias('Maximo en hora de México y SAP por día calendario')}.`,
    }),
    montos: por({
      maximo: sapMigradas
        ? `Montos adjudicados = OC de SAP creadas desde Maximo por la integración, no canceladas (estatus actual), ${sinContrato} en Maximo, ${baseDetalle}, por mes de la OC en SAP; ${aPesos}. El valor ${otro} va aparte. ${soloAqui}`
        : `Montos adjudicados = OC de Maximo no canceladas (estatus actual), ${sinContrato}, ${baseDetalle}, por mes de creación de la OC; ${aPesos}. Incluye las que la integración pasó a SAP. El valor ${otro} va aparte. ${soloAqui}`,
      sap: `Montos adjudicados = OC de SAP no canceladas (estatus actual), ${baseDetalle}, por mes de creación de la OC y por moneda; USD aparte, sin convertir. Sin las OC que la integración creó desde Maximo: son de la gestión de Maximo y se cuentan en su página (las de contrato, en ninguna). El valor ${otro} va aparte.`,
      todas: `Montos adjudicados = OC no canceladas (estatus actual), ${base}, por mes de creación de la OC. Las de Maximo, sin las de contrato y con dólares y euros en pesos (${tipoCambioTexto(opciones.tipo_cambio)}); las de SAP, por moneda, sin convertir. Las OC de SAP creadas desde Maximo se cuentan una vez${sapMigradas ? ' (las de Maximo salen de esas OC de SAP)' : ''}. El valor ${otro} va aparte.`,
    }),
    semana: por({
      maximo: `Semana ${semanaDe}, con corte el ${diaCorte} a las 23:59 hora de México (las fechas de Maximo traen hora); la etiqueta va de lunes a viernes, como el reporte de Jorge.`,
      sap: `Semana ${semanaDe} por día calendario (la fecha de la solicitud no trae hora); la etiqueta va de lunes a viernes, como el reporte de Jorge.`,
      todas: `Semana ${semanaDe}: Maximo con corte el ${diaCorte} a las 23:59 hora de México y SAP por día calendario; la etiqueta va de lunes a viernes, como el reporte de Jorge.`,
    }),
    homologacion: por({
      maximo: `Diferencia con la página de SAP: SAP cuenta la solicitud desde su fecha (sin hora, por día calendario) y la cancela con su última actualización; aquí la PR cuenta desde su ${aprobacion ? 'primera aprobación (llegada a Compras)' : 'emisión'}, en hora de México, y se cancela con la CAN de su historial. ${diasIguales('las dos páginas')}`,
      sap: `Diferencia con la página de Maximo: Maximo cuenta la PR desde su ${aprobacion ? 'primera aprobación (llegada a Compras)' : 'emisión'}, en hora de México, y la cancela con la CAN de su historial; aquí la solicitud cuenta desde su fecha en SAP, por día calendario. ${diasIguales('las dos páginas')}`,
      todas: `Cada fuente se suma con su propia definición: SAP por la fecha de la solicitud (día calendario) y Maximo por la de la PR (hora de México). ${diasIguales('las dos fuentes')}`,
    }),
  };
  // O1.3: qué promedio es el número grande de las tarjetas de días
  definiciones.promedio_titulo =
    opciones.promedio_titulo === 'semana'
      ? 'El número grande de las tarjetas de días es el promedio de la semana; el del año sigue en el Excel semanal.'
      : 'El número grande de las tarjetas de días es el promedio del año; el de cada semana va en la tabla de abajo.';
  // L2: solo la página de Maximo; sin 'contrato' las definiciones no cambian
  if (fuente === 'maximo' && grupos === 'contrato') {
    definiciones.grupos = `Grupos de la dona, los medidores y las barras: ${GRUPOS_ETIQUETA.cerradas_sin_contrato} = PR sin contrato cerradas al corte (con OC o por CLOSE); ${GRUPOS_ETIQUETA.de_contrato} = PR con contrato cerradas al corte (con OC o por CLOSE); ${GRUPOS_ETIQUETA.canceladas} = PR canceladas en Maximo (última CAN de su historial), con o sin contrato; ${GRUPOS_ETIQUETA.abiertas} = sin cerrar ni cancelar al corte. Los cuatro suman las recibidas. Los indicadores no cambian: las cerradas de la tarjeta de avance son ${grupoEnFrase('cerradas_sin_contrato')} + ${grupoEnFrase('de_contrato')}, y las atendidas son cerradas + canceladas.`;
  }
  return definiciones;
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

/**
 * Lunes de la última semana completa: la anterior a la de `now` o, si ya
 * pasó su corte (sábado y domingo con corte el viernes), la de `now`.
 */
export function lastCompleteWeek(
  now = new Date(),
  corte: AvanceCorte = AVANCE_REGLAS.corte,
): Date {
  // O1: con corte el viernes, en sábado y domingo la semana en curso ya
  // cerró (se toma el corte de Maximo, el más tardío de los dos sistemas)
  const actual = mondayOf(now);
  return now.getTime() >= ventanaSemana(actual, 'maximo', corte).fin
    ? actual
    : new Date(actual.getTime() - WEEK_MS);
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

// ── Días hábiles (H3) ───────────────────────────────────────────────────

/** Festivos 'YYYY-MM-DD' → número de día (días desde el 1-ene-1970), una vez por lista. */
const festivosPorLista = new WeakMap<readonly string[], Set<number>>();

function numerosDeFestivos(festivos: readonly string[]): Set<number> {
  let numeros = festivosPorLista.get(festivos);
  if (!numeros) {
    numeros = new Set(festivos.map((f) => parseDay(f).getTime() / DAY_MS));
    festivosPorLista.set(festivos, numeros);
  }
  return numeros;
}

/**
 * H3 (calibración del 5-oct: 17.1 días naturales ≈ 12 hábiles; Jorge
 * reporta 11): días hábiles de `desde` a `hasta`, con fracción como
 * `gestionDays`. Lleva las dos fechas a la hora local del sistema (Maximo en
 * hora de México, como el corte; SAP por día calendario), recorre los días
 * locales entre las dos y suma solo la parte del intervalo que cae de lunes
 * a viernes en días que no están en `festivos` ('YYYY-MM-DD'). Viernes 17:00
 * a lunes 09:00 = 7 h + 9 h; de un lunes 00:00 al siguiente = 5. Evento
 * anterior al inicio → null (fuera del promedio, como `gestionDays`).
 *
 * No es `calculateBusinessDays` (common/utils/business-days.ts): ésa cuenta
 * días enteros inclusivos (aprobaciones); aquí cuenta el tiempo.
 */
export function diasHabiles(
  desde: Date,
  hasta: Date,
  sistema: AvanceSistema,
  festivos: readonly string[] = [],
): number | null {
  const a = desde.getTime() - desfase(sistema);
  const b = hasta.getTime() - desfase(sistema);
  if (b < a) return null;
  const inhabiles = numerosDeFestivos(festivos);
  let ms = 0;
  for (let dia = Math.floor(a / DAY_MS); dia * DAY_MS < b; dia += 1) {
    // el día 0 (1-ene-1970) fue jueves: 0 = domingo … 6 = sábado
    const semana = (((dia + 4) % 7) + 7) % 7;
    if (semana === 0 || semana === 6 || inhabiles.has(dia)) continue;
    ms += Math.min(b, (dia + 1) * DAY_MS) - Math.max(a, dia * DAY_MS);
  }
  return ms / DAY_MS;
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
 * H3: naturales con `gestionDays` (sin cambio) o hábiles con `diasHabiles`
 * en la hora local de su sistema.
 */
export function diasHasta(
  g: Gestion,
  evento: Date | null,
  dias: CuentaDias = DIAS_NATURALES,
): number | null {
  if (!evento || !g.inicio_dias) return null;
  return dias.tipo === 'habiles'
    ? diasHabiles(g.inicio_dias, evento, g.sistema, dias.festivos)
    : gestionDays(g.inicio_dias, evento);
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
    cerradas_de_contrato: 0,
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

/**
 * L2 (vista previa, `grupos='contrato'`): las recibidas de un conteo en
 * cuatro grupos que las suman. Las PR de contrato cerradas al corte
 * (`cerradas_de_contrato`, con OC o por CLOSE) salen de las cerradas, y las
 * que quedan son las cerradas sin contrato; las canceladas son las CAN de
 * Maximo (la PR de contrato cancelada va ahí, no con las de contrato). Los
 * conteos y los KPIs no se tocan.
 */
export function gruposContrato(c: ConteoEstados): GruposConteo {
  const valores: Record<GrupoClave, number> = {
    cerradas_sin_contrato: c.cerradas - c.cerradas_de_contrato,
    de_contrato: c.cerradas_de_contrato,
    canceladas: c.canceladas,
    abiertas: c.abiertas,
  };
  const claves: GrupoClave[] = [
    'cerradas_sin_contrato',
    'de_contrato',
    'canceladas',
    'abiertas',
  ];
  return {
    recibidas: c.recibidas,
    grupos: claves.map((clave) => ({
      clave,
      etiqueta: GRUPOS_ETIQUETA[clave],
      valor: valores[clave],
      pct:
        c.recibidas === 0 ? null : round1((valores[clave] / c.recibidas) * 100),
    })),
  };
}

/**
 * Cohortes de varios años al corte de la semana del `lunes`, en una sola
 * pasada. `dias` (H3): naturales (default) o hábiles con sus festivos.
 */
export function cohortes(
  gestiones: Gestion[],
  anios: number[],
  lunes: Date,
  corte: AvanceCorte = AVANCE_REGLAS.corte,
  dias: CuentaDias = DIAS_NATURALES,
): CohorteAnio[] {
  return cohortesAl(gestiones, anios, finesDeSemana(lunes, corte), dias);
}

/**
 * O1.5: la cohorte del año de `dia` al final de ese día (23:59 hora de
 * México en Maximo; SAP, ese día calendario), para comparar con un informe
 * de Jorge que no cae en viernes (p. ej. el de RQ del martes 20-oct).
 */
export function cohorteAlDia(
  data: AvanceData,
  dia: Date,
  fuente: AvanceFuente,
  opciones: AvanceOpciones = AVANCE_OPCIONES,
): CohorteAnio {
  const fin = parseDay(isoDay(dia)).getTime() + DAY_MS;
  return cohortesAl(
    data.gestiones.filter((g) => enFuente(g.sistema, fuente)),
    [dia.getUTCFullYear()],
    { sap: fin, maximo: fin + MX_OFFSET_MS },
    { tipo: opciones.reglas.dias_tipo, festivos: data.festivos ?? [] },
  )[0];
}

function cohortesAl(
  gestiones: Gestion[],
  anios: number[],
  fines: Record<AvanceSistema, number>,
  dias: CuentaDias,
): CohorteAnio[] {
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
      // H2: con OC o por CLOSE, la PR de contrato cerrada al corte
      if (g.sistema === 'maximo' && g.de_contrato) {
        c.cerradas_de_contrato += 1;
      }
      if (!e.con_oc) {
        c.cerradas_sin_oc += 1;
        if (g.sistema === 'maximo' && !g.de_contrato) {
          c.cerradas_sin_oc_ni_contrato += 1;
        }
      } else {
        const days = diasHasta(g, g.primera_oc, dias);
        if (days !== null) entry.cierre.push(days);
      }
    } else if (e.estado === 'cancelada') {
      c.canceladas += 1;
      const days = diasHasta(g, g.cancelada, dias);
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

/**
 * Lo que pasó en la semana del `lunes` (recibidas, cierres y
 * cancelaciones). `dias` (H3): naturales (default) o hábiles.
 */
export function semanaStats(
  gestiones: Gestion[],
  lunes: Date,
  corte: AvanceCorte = AVANCE_REGLAS.corte,
  dias: CuentaDias = DIAS_NATURALES,
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
        const days = diasHasta(g, g.primera_oc, dias);
        if (days !== null) cierre.push(days);
      }
    } else if (e.estado === 'cancelada') {
      canceladas += 1;
      const days = diasHasta(g, g.cancelada, dias);
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

/** I3/D1: la OC es del lado de Maximo de los montos (sus OC o, con `sap_migradas`, sus copias en SAP). */
function deLaGestionDeMaximo(
  o: OrdenMonto,
  montosFuente: AvanceMontosFuente,
): boolean {
  return montosFuente === 'sap_migradas'
    ? o.sistema === 'sap' && o.contada_en_maximo && o.copia_migrada !== true
    : o.sistema === 'maximo';
}

/**
 * OC que suma la página. I3/D1: la OC de SAP creada desde Maximo es de la
 * gestión de Maximo (nunca en la de SAP). Con `sap_migradas`, Maximo toma
 * esas OC de SAP en lugar de las suyas, una por PO (sin las copias extra).
 */
function ordenDeLaPagina(
  o: OrdenMonto,
  fuente: AvanceFuente,
  montosFuente: AvanceMontosFuente,
): boolean {
  const deMaximo = deLaGestionDeMaximo(o, montosFuente);
  const deSap = o.sistema === 'sap' && !o.contada_en_maximo;
  if (fuente === 'maximo') return deMaximo;
  if (fuente === 'sap') return deSap;
  return deMaximo || deSap;
}

const sumar = (acc: Record<string, number>, moneda: string, valor: number) => {
  acc[moneda] = round2((acc[moneda] ?? 0) + valor);
};

/** O1: pesos por dólar del día, o del día anterior más cercano que lo tenga. */
function mxnPorUsdAl(tipos: TiposCambio, dia: string): number | null {
  const lista = tipos.maximo_dia;
  let lo = 0;
  let hi = lista.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lista[mid].dia <= dia) {
      found = lista[mid].mxn_por_usd;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * O1 (2026-10-26): pesos por unidad de la moneda de una OC en dólares o
 * euros, el día de la OC (hora de México en Maximo; SAP, su día):
 *  - 'maximo': USD = pesos por dólar del día (1 / EXCHANGERATE de las OC en
 *    pesos de ese día o del anterior más cercano); EUR = eso × el
 *    EXCHANGERATE de la OC (dólares por euro). Sin eso, el de referencia;
 *  - 'sap' (o sin tipo de Maximo): el de referencia de SAP del mes de esa
 *    moneda; un euro sin referencia de euros ese mes, el de dólares × su
 *    EXCHANGERATE (así los dos tipos convierten las mismas OC).
 * null = la moneda no se convierte o no hay ningún tipo de cambio.
 */
export function tipoDeCambio(
  o: OrdenMonto,
  tipos: TiposCambio | undefined,
  tipo: AvanceTipoCambio,
): { mxn_por_unidad: number; fuente: 'maximo' | 'referencia' } | null {
  if (!tipos || !o.moneda || !MONEDAS_CONVERTIBLES.includes(o.moneda)) {
    return null;
  }
  const dia = isoDay(new Date(o.fecha.getTime() - desfase(o.sistema)));
  if (tipo === 'maximo') {
    const usd = mxnPorUsdAl(tipos, dia);
    if (usd !== null && o.moneda === 'USD') {
      return { mxn_por_unidad: usd, fuente: 'maximo' };
    }
    if (usd !== null && o.tc_usd && o.tc_usd > 0) {
      return { mxn_por_unidad: usd * o.tc_usd, fuente: 'maximo' };
    }
  }
  const mes = dia.slice(0, 7);
  const referencia = tipos.sap_mes[`${o.moneda}|${mes}`];
  if (referencia) return { mxn_por_unidad: referencia, fuente: 'referencia' };
  const dolar = tipos.sap_mes[`USD|${mes}`];
  if (o.moneda === 'EUR' && dolar && o.tc_usd && o.tc_usd > 0) {
    return { mxn_por_unidad: dolar * o.tc_usd, fuente: 'referencia' };
  }
  return null;
}

/**
 * OC del año por mes de creación y por moneda, hasta el corte de la semana
 * del `lunes`, en la base de `opciones.monto_base` (K5/K6). El otro valor
 * va por moneda en `otro`; las OC sin subtotal se cuentan en `sin_subtotal`
 * y no se estiman (con base sin IVA no se suman).
 *
 * O1 (2026-10-26): las OC del lado de Maximo (página de Maximo y `todas`)
 * no suman si son de contrato y, en dólares o euros, pasan a pesos con
 * `tipoDeCambio` (los dos valores, con y sin IVA); sin tipo de cambio se
 * quedan en su moneda. Lo que se hizo va en `maximo`.
 */
export function montosAdjudicados(
  ordenes: OrdenMonto[],
  fuente: AvanceFuente,
  anio: number,
  lunes: Date,
  opciones: AvanceOpciones = AVANCE_OPCIONES,
  tiposCambio?: TiposCambio,
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
    sin_subtotal: {} as Record<string, number>,
  }));
  const total: Record<string, number> = {};
  const otroTotal: Record<string, number> = {};
  const sinSubtotal = { ordenes: 0, con_iva: {} as Record<string, number> };
  let count = 0;
  let migradas = 0;
  // O1: las OC de Maximo de la página (sin la de SAP)
  const maximo: MontosMaximo | null =
    fuente === 'sap'
      ? null
      : {
          tipo_cambio: opciones.tipo_cambio,
          contrato: { ordenes: 0, con_iva: {} },
          convertidas: {},
          con_referencia: 0,
          sin_tipo_cambio: 0,
        };
  for (const o of ordenes) {
    if (
      anioDe(o.fecha, o.sistema) !== anio ||
      o.fecha.getTime() >= fines[o.sistema]
    ) {
      continue;
    }
    if (!ordenDeLaPagina(o, fuente, opciones.montos_fuente_maximo)) {
      // I3: la OC de SAP creada desde Maximo es de la gestión de Maximo
      // (se cuentan documentos de SAP, copias incluidas, como Órdenes SAP)
      if (fuente === 'sap' && o.contada_en_maximo) migradas += 1;
      continue;
    }
    const mes = meses[mesDe(o.fecha, o.sistema)];
    if (!mes) continue;
    let moneda = o.moneda ?? SIN_MONEDA;
    let factor = 1;
    if (
      maximo !== null &&
      deLaGestionDeMaximo(o, opciones.montos_fuente_maximo)
    ) {
      // O1: la OC de contrato no pasa por RQ y no es del reporte de Compras
      if (o.de_contrato) {
        maximo.contrato.ordenes += 1;
        sumar(maximo.contrato.con_iva, moneda, o.monto);
        continue;
      }
      if (MONEDAS_CONVERTIBLES.includes(moneda)) {
        const tc = tipoDeCambio(o, tiposCambio, opciones.tipo_cambio);
        if (tc) {
          factor = tc.mxn_por_unidad;
          const c = maximo.convertidas[moneda] ?? {
            ordenes: 0,
            original: 0,
            mxn: 0,
          };
          maximo.convertidas[moneda] = {
            ordenes: c.ordenes + 1,
            original: round2(c.original + o.monto),
            mxn: round2(c.mxn + o.monto * factor),
          };
          if (tc.fuente === 'referencia') maximo.con_referencia += 1;
          moneda = 'MXN';
        } else {
          maximo.sin_tipo_cambio += 1;
        }
      }
    }
    const enPesos = (v: number | null) => (v === null ? null : v * factor);
    const valor = enPesos(base === 'sin_iva' ? o.subtotal : o.monto);
    const otro = enPesos(base === 'sin_iva' ? o.monto : o.subtotal);
    if (o.subtotal === null) {
      sinSubtotal.ordenes += 1;
      sumar(sinSubtotal.con_iva, moneda, o.monto * factor);
      sumar(mes.sin_subtotal, moneda, 1);
    }
    if (valor !== null) {
      sumar(mes.montos, moneda, valor);
      mes.ordenes += 1;
      sumar(total, moneda, valor);
      count += 1;
    }
    if (otro !== null) sumar(otroTotal, moneda, otro);
  }
  const deSapMigradas = opciones.montos_fuente_maximo === 'sap_migradas';
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
    descripcion:
      fuente === 'sap'
        ? `OC no canceladas, ${montoBaseTexto(base)}, por mes de la OC`
        : fuente === 'todas'
          ? `OC no canceladas, ${montoBaseTexto(base)}, por mes de la OC; las de Maximo sin las de contrato y con USD y EUR en pesos; las de SAP por moneda, sin convertir`
          : `${deSapMigradas ? 'OC de SAP creadas desde Maximo' : 'OC'} no canceladas sin las de contrato, ${montoBaseTexto(base)}, por mes de la OC; USD y EUR en pesos`,
    maximo,
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

/**
 * L2: la nota de las PR cerradas en Maximo sin OC con grupos: en vez de
 * "cuentan como cerradas", el grupo donde va cada una ("54 PR cerradas en
 * Maximo sin OC (sin días): 19 van en Cerradas sin contrato y 35 en De
 * contrato (OC automática)").
 */
function notaCerradasSinOcPorGrupo(total: number, sinContrato: number): string {
  const destinos = [
    { n: sinContrato, grupo: GRUPOS_ETIQUETA.cerradas_sin_contrato },
    { n: total - sinContrato, grupo: GRUPOS_ETIQUETA.de_contrato },
  ].filter((d) => d.n > 0);
  const inicio = `${plural(total, 'PR cerrada', 'PR cerradas')} en Maximo sin OC (sin días)`;
  if (destinos.length === 1) {
    return `${inicio} ${total === 1 ? 'va' : 'van'} en ${destinos[0].grupo}.`;
  }
  const [a, b] = destinos;
  return `${inicio}: ${fmtCount(a.n)} ${a.n === 1 ? 'va' : 'van'} en ${a.grupo} y ${fmtCount(b.n)} en ${b.grupo}.`;
}

/**
 * O1: la nota de los montos. En la página de SAP, como siempre (cada moneda
 * aparte). Con OC de Maximo: sin las de contrato, cuántas se pasaron a pesos
 * y con qué tipo de cambio (el de referencia de SAP se dice), y que esto
 * solo pasa en el avance.
 */
function notaMontos(
  m: MontosAnio,
  fuente: AvanceFuente,
  opciones: AvanceOpciones,
): string {
  const base = `Montos ${montoBaseTexto(opciones.monto_base)}${opciones.monto_base === 'sin_iva' ? ' (suma de las líneas de la OC)' : ''} por mes de creación de la OC; OC no canceladas`;
  if (m.maximo === null) return `${base}; cada moneda aparte, sin convertir.`;
  const mx = m.maximo;
  // corta: las cifras (contrato y lo convertido) van en la tarjeta de montos,
  // el JSON y el Excel; el pie del PDF tiene tope de alto
  const contrato =
    mx.contrato.ordenes > 0
      ? `sin las de contrato (${plural(mx.contrato.ordenes, 'OC', 'OC')})`
      : 'sin las de contrato';
  const convertidas = Object.values(mx.convertidas).reduce(
    (n, c) => n + c.ordenes,
    0,
  );
  const pesos = `dólares y euros en pesos${convertidas > 0 ? ` (${plural(convertidas, 'OC', 'OC')})` : ''} con ${tipoCambioTexto(mx.tipo_cambio)}`;
  const referencia =
    mx.tipo_cambio === 'maximo' && mx.con_referencia > 0
      ? `; ${plural(mx.con_referencia, 'OC', 'OC')} con el tipo de referencia de SAP del mes`
      : '';
  const sinTc =
    mx.sin_tipo_cambio > 0
      ? `; ${plural(mx.sin_tipo_cambio, 'OC sin tipo de cambio queda', 'OC sin tipo de cambio quedan')} en su moneda`
      : '';
  const maximo = `${contrato}; ${pesos}${referencia}${sinTc}`;
  return fuente === 'todas'
    ? `${base}. Las de Maximo, ${maximo}; las de SAP, cada moneda aparte, sin convertir. Solo en este reporte: Órdenes y el resto de Compras no quitan las OC de contrato ni convierten monedas.`
    : `${base}, ${maximo}. Solo en este reporte: Órdenes y el resto de Compras no quitan las OC de contrato ni convierten monedas.`;
}

/**
 * Página de una semana. L2: `grupos` (default AVANCE_GRUPOS_MAXIMO) solo
 * cambia la página de Maximo: con 'contrato' le agrega el bloque `grupos` y
 * dice en qué grupo van las PR cerradas sin OC; con 'estandar' sale igual
 * que antes de L2.
 */
export function buildAvancePage(
  data: AvanceData,
  lunes: Date,
  fuente: AvanceFuente,
  generado: Date,
  opciones: AvanceOpciones = AVANCE_OPCIONES,
  grupos: AvanceGrupos = AVANCE_GRUPOS_MAXIMO,
): AvancePage {
  const { corte } = opciones.reglas;
  // H3: días naturales o hábiles (con los festivos cargados), las dos fuentes
  const cuenta: CuentaDias = {
    tipo: opciones.reglas.dias_tipo,
    festivos: data.festivos ?? [],
  };
  const unidad = diasTexto(cuenta.tipo);
  const semanaInicio = mondayOf(lunes);
  const start = semanaInicio.getTime();
  const anio = semanaInicio.getUTCFullYear();
  const gestiones = data.gestiones.filter((g) => enFuente(g.sistema, fuente));

  const anios = [anio - 4, anio - 3, anio - 2, anio - 1, anio];
  const anual = cohortes(gestiones, anios, semanaInicio, corte, cuenta);
  const actual = anual[anual.length - 1];
  const previo = anual[anual.length - 2];
  const semana = semanaStats(gestiones, semanaInicio, corte, cuenta);
  const ultimas = [3, 2, 1, 0].map((k) =>
    k === 0
      ? semana
      : semanaStats(gestiones, new Date(start - k * WEEK_MS), corte, cuenta),
  );

  const conSap = fuente !== 'maximo';
  const conMaximo = fuente !== 'sap';
  // L2: los grupos son solo de la página de Maximo
  const conGrupos = fuente === 'maximo' && grupos === 'contrato';
  const dias = notasDias(fuente, opciones);

  const porSistema: AvancePage['por_sistema'] = {};
  if (fuente === 'todas') {
    for (const sistema of ['sap', 'maximo'] as const) {
      const propias = gestiones.filter((g) => g.sistema === sistema);
      const [cohorte] = cohortes(propias, [anio], semanaInicio, corte, cuenta);
      const sem = semanaStats(propias, semanaInicio, corte, cuenta);
      porSistema[sistema] = {
        recibidas_anio: cohorte.recibidas,
        nuevas_semana: sem.nuevas,
        cerradas_anio: cohorte.cerradas,
        cerradas_semana: sem.cerradas,
        dias_cierre: cohorte.dias_cierre,
      };
    }
  }

  // K5: PR de Maximo emitidas en el año (al corte) que no entran al universo.
  // H6: al corte T, también las aprobadas después de T (hoy ya tienen APPR,
  // pero esa semana todavía no llegaban a Compras); con 'emision' no hay
  // ninguna (la llegada es la propia emisión).
  const finMaximo = ventanaSemana(semanaInicio, 'maximo', corte).fin;
  const emitidaAlCorte = (emision: Date | null | undefined) =>
    emision !== null &&
    emision !== undefined &&
    emision.getTime() < finMaximo &&
    anioDe(emision, 'maximo') === anio;
  const noRecibidas = conMaximo
    ? data.maximo_no_recibidas.filter((p) => emitidaAlCorte(p.emision)).length +
      data.gestiones.filter(
        (g) =>
          g.sistema === 'maximo' &&
          g.recibida.getTime() >= finMaximo &&
          emitidaAlCorte(g.emision),
      ).length
    : null;

  const montos = montosAdjudicados(
    data.ordenes,
    fuente,
    anio,
    semanaInicio,
    opciones,
    data.tipos_cambio,
  );

  const notas: string[] = [];
  if (noRecibidas) {
    notas.push(
      noRecibidas === 1
        ? `1 PR de Maximo emitida en ${anio} no se ha aprobado (en aprobación o cancelada sin aprobar): no llegó a Compras y no cuenta como recibida.`
        : `${fmtCount(noRecibidas)} PR de Maximo emitidas en ${anio} no se han aprobado (en aprobación o canceladas sin aprobar): no llegaron a Compras y no cuentan como recibidas.`,
    );
  }
  if (cuenta.tipo === 'habiles') {
    notas.push(
      cuenta.festivos.length > 0
        ? 'Días de cierre y de cancelación en días hábiles: de lunes a viernes, sin los días festivos registrados.'
        : 'Días de cierre y de cancelación en días hábiles: de lunes a viernes (no hay días festivos registrados).',
    );
  }
  notas.push(notaMontos(montos, fuente, opciones));
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
      'Las OC de SAP creadas desde Maximo se cuentan una vez, del lado de Maximo; las de contrato no se suman.',
    );
  }
  if (montos.migradas_excluidas === 1) {
    notas.push(
      `1 OC de SAP creada desde Maximo en ${anio} no se suma aquí: es de la gestión de Maximo y se cuenta en su página, salvo si es de contrato.`,
    );
  } else if (montos.migradas_excluidas > 1) {
    notas.push(
      `${fmtCount(montos.migradas_excluidas)} OC de SAP creadas desde Maximo en ${anio} no se suman aquí: son de la gestión de Maximo y se cuentan en su página, salvo las de contrato.`,
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
    if (conGrupos) {
      // L2: con grupos (solo Maximo), en qué grupo va cada una: las de
      // contrato no están en "Cerradas sin contrato"
      notas.push(notaCerradasSinOcPorGrupo(sinOc.maximo, sinContrato));
    } else {
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
  // O1.3: el promedio grande de las tarjetas de días
  const titulo = (anioStats: DiasStats | null, semanaStats: DiasStats) => ({
    promedio: opciones.promedio_titulo,
    dias: opciones.promedio_titulo === 'semana' ? semanaStats : anioStats,
  });
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
      // O1.4: hasta O2 (RQ de CIISA), la recibida de Maximo es una aproximación
      leyenda:
        fuente === 'maximo'
          ? `Recibidas = PR ${opciones.reglas.recibida === 'aprobacion' ? 'aprobadas' : 'emitidas'} (aproximación); el reporte de Compras cuenta solicitudes de cotización (RQ).`
          : null,
    },
    cierre: {
      nota: dias.cierre,
      unidad,
      anio: actual.dias_cierre,
      titulo: titulo(actual.dias_cierre, semana.dias_cierre),
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
      unidad,
      anio: actual.dias_cancelacion,
      titulo: titulo(actual.dias_cancelacion, semana.dias_cancelacion),
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
      cerradas_de_contrato: actual.cerradas_de_contrato,
      canceladas: actual.canceladas,
      abiertas: actual.abiertas,
      atendidas: actual.atendidas,
      atendidas_pct: actual.atendidas_pct,
    },
    anual,
    // L2: sin 'contrato' (o fuera de Maximo) no se agrega la llave
    ...(conGrupos
      ? {
          grupos: {
            modo: 'contrato' as const,
            estado_anio: gruposContrato(actual),
            anual: anual.map((c) => ({ anio: c.anio, ...gruposContrato(c) })),
          },
        }
      : {}),
    montos,
    por_sistema: porSistema,
    no_disponible: [],
    notas,
    generado: generado.toISOString(),
  };
}
