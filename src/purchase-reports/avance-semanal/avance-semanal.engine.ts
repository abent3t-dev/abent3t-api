import {
  averageAndMedian,
  gestionDays,
} from '../../purchase-dashboard/sap-gestion-days';

/**
 * H1 (reunión con Ingrid 2026-09-29) — "Reporte de avance semanal": la hoja
 * que Jorge arma a mano cada viernes, generada por la plataforma. Motor ÚNICO
 * de KPIs: recibe los datos ya cargados (avance-semanal.data.ts) y una
 * semana, y devuelve el JSON de la página. El acumulado rebana los mismos
 * datos semana por semana (no repite consultas).
 *
 * Definiciones PROVISIONALES (TAREAS_COMPRAS_2026-09-29 § H1; las confirman
 * Ingrid y Jorge). Cualquier cambio de regla va en este archivo:
 *  - Gestión = solicitud de compra: solicitud de pedido de SAP o PR de
 *    Maximo. I3 (go-live 2026-09-30, Ingrid): "uno de Maximo, uno de SAP y
 *    esté homologado" — el reporte por defecto (`ambos`) trae una página de
 *    Maximo y una de SAP por semana, con el mismo formato; `todas` (las dos
 *    sumadas) queda solo en la API.
 *  - Recibida = fecha de la solicitud (SAP DocDate; Maximo ISSUEDATE, que
 *    solo llega con la OC: las demás se ubican aproximadas, ver data.ts).
 *  - Por año = por COHORTE: las recibidas en el año y, de esas, cuántas están
 *    cerradas, canceladas o abiertas al cierre de la semana.
 *  - Cerrada = tiene su primera OC no cancelada; fecha de cierre = la OC.
 *    También cierran sin OC (y sin días): las de SAP cerradas a mano y las
 *    PR de Maximo que se volvieron contrato.
 *  - Cancelada: solo SAP (fecha = UpdateDate). Maximo no envía el estatus de
 *    las PR: las que no tienen OC son "sin OC", ni canceladas ni abiertas.
 *  - Días = `gestionDays` (la misma cuenta que G2) con promedio y mediana.
 *  - Montos adjudicados = OC no canceladas, con IVA, por mes de la OC y por
 *    moneda (USD aparte, sin convertir). Las OC de SAP creadas desde Maximo
 *    son de la gestión de Maximo: cuentan en su página y no en la de SAP
 *    (I3; con `todas`, una vez, D1), para no comprar dos veces lo migrado.
 *  - Semana de lunes a domingo en UTC (como el resto de Reportes); la
 *    etiqueta va de lunes a viernes como la de Jorge. El año de la semana es
 *    el de su lunes (la del 29-dic-2025 es de 2025, como en su archivo).
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

/** Cómo se conoce la fecha en que se recibió la gestión. */
export type FechaOrigen = 'exacta' | 'alta' | 'folio';

export interface Gestion {
  sistema: AvanceSistema;
  /** DocNum de la solicitud de SAP o PRNUM de Maximo. */
  folio: string;
  recibida: Date;
  /** `alta` y `folio` = aproximada (PR de Maximo sin ISSUEDATE). */
  fecha_origen: FechaOrigen;
  /** Fecha de su primera OC no cancelada; null = sin OC. */
  primera_oc: Date | null;
  /** Cierre sin OC: SAP cerrada a mano; PR de Maximo que se volvió contrato. */
  cierre_sin_oc: Date | null;
  /** Solo SAP (UpdateDate de la cancelada). Maximo: null, no disponible. */
  cancelada: Date | null;
}

export interface OrdenMonto {
  sistema: AvanceSistema;
  fecha: Date;
  moneda: string | null;
  /** Con IVA, en la moneda del documento. */
  monto: number;
  /** OC de SAP creada desde Maximo que existe en Maximo: con `todas` cuenta en Maximo (D1). */
  contada_en_maximo: boolean;
}

export interface AvanceData {
  gestiones: Gestion[];
  ordenes: OrdenMonto[];
  /** PR de Maximo que no se pueden ubicar en el tiempo (sin fechas conocidas). */
  maximo_sin_fecha: number;
  /** Primera solicitud de SAP (SAP tiene solicitudes desde ene-2026). */
  sap_desde: Date | null;
}

export interface DiasStats {
  promedio_dias: number | null;
  mediana_dias: number | null;
  /** Gestiones con días (las que tienen OC; negativos fuera, como en G2). */
  total: number;
}

export interface ConteoEstados {
  recibidas: number;
  /** Incluye las cerradas sin OC. */
  cerradas: number;
  cerradas_sin_oc: number;
  canceladas: number;
  /** SAP: recibidas sin cerrar ni cancelar. */
  abiertas: number;
  /** Maximo: PR sin OC (Maximo no dice si siguen abiertas o se cancelaron). */
  sin_oc: number;
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
  nuevas_aproximadas: number;
  cerradas: number;
  /** De esas, las recibidas en años anteriores. */
  cerradas_anteriores: number;
  canceladas: number;
  dias_cierre: DiasStats;
  dias_cancelacion: DiasStats;
}

export interface MontosAnio {
  anio: number;
  /** MXN primero, luego USD y el resto. */
  monedas: string[];
  meses: Array<{
    mes: number;
    etiqueta: string;
    montos: Record<string, number>;
    ordenes: number;
  }>;
  total: Record<string, number>;
  ordenes: number;
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
    /** Corte de los datos: el domingo ("27 de septiembre de 2026"). */
    corte: string;
  };
  fuente: { clave: AvanceFuente; etiqueta: string };
  avance: {
    recibidas_anio: number;
    nuevas_semana: number;
    nuevas_aproximadas: number;
    cerradas_anio: number;
    cerradas_semana: number;
    cerradas_semana_anteriores: number;
    /** Solo en semanas de enero: lo que sigue sin atender del año anterior. */
    anio_anterior: { anio: number; abiertas: number; sin_oc: number } | null;
  };
  cierre: {
    anio: DiasStats;
    semanas: Array<{
      lunes: string;
      etiqueta: string;
      cerradas: number;
      dias: DiasStats;
    }>;
  };
  cancelacion: {
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
  no_disponible: Array<{ dato: string; motivo: string }>;
  notas: string[];
  generado: string;
}

export const MAXIMO_NOTA_ESTANDAR =
  'Maximo no envía el estatus ni la fecha de las solicitudes que no tienen OC: las recibidas se ubican por folio (aproximado) y las canceladas no están disponibles hasta que CIISA exponga esos campos.';

/**
 * Definiciones de la página (JSON y Excel). I3: cada página habla solo de su
 * sistema; `todas` conserva el texto de las dos.
 */
export function avanceDefiniciones(
  fuente: AvanceFuente,
): Record<string, string> {
  const por = (textos: Record<AvanceFuente, string>) => textos[fuente];
  return {
    gestion: por({
      maximo: 'Gestión = PR de Maximo (solicitud de compra).',
      sap: 'Gestión = solicitud de pedido de SAP.',
      todas:
        'Gestión = solicitud de compra: solicitud de pedido de SAP y PR de Maximo.',
    }),
    recibida: por({
      maximo:
        'Recibida = fecha de la PR. Maximo solo da la fecha (ISSUEDATE) de las PR que ya tienen OC; las demás son aproximadas: la fecha en que la plataforma vio la PR por primera vez (desde que la integración está activa) o, antes, su folio (Maximo numera las PR en orden).',
      sap: 'Recibida = fecha de la solicitud de pedido en SAP.',
      todas:
        'Recibida = fecha de la solicitud. Maximo solo da la fecha (ISSUEDATE) de las PR que ya tienen OC; las demás son aproximadas: la fecha en que la plataforma vio la PR por primera vez (desde que la integración está activa) o, antes, su folio (Maximo numera las PR en orden).',
    }),
    cohorte:
      'Por año = por cohorte: de las recibidas en el año, cuántas están cerradas, canceladas o abiertas al cierre de la semana.',
    cerrada: por({
      maximo:
        'Cerrada = la PR tiene su primera OC no cancelada; la fecha de cierre es la de esa OC. También cierran, sin días, las PR que se volvieron contrato.',
      sap: 'Cerrada = la solicitud tiene su primera OC no cancelada; la fecha de cierre es la de esa OC. También cierran, sin días, las solicitudes cerradas a mano sin OC.',
      todas:
        'Cerrada = tiene su primera OC no cancelada; la fecha de cierre es la de esa OC. También cierran, sin días, las solicitudes de SAP cerradas a mano sin OC y las PR de Maximo que se volvieron contrato.',
    }),
    cancelada: por({
      maximo:
        'Cancelada = no disponible: Maximo no envía el estatus de las PR; las que no tienen OC salen como "sin OC".',
      sap: 'Cancelada = solicitud cancelada en SAP (fecha = última actualización de la solicitud).',
      todas:
        'Cancelada = solo SAP (fecha = última actualización de la solicitud). Maximo no envía el estatus de las PR: las que no tienen OC salen como "sin OC".',
    }),
    dias: 'Días de cierre = de la solicitud a su primera OC, con promedio y mediana (la misma cuenta que los días de gestión del tablero).',
    montos: por({
      maximo:
        'Montos adjudicados = OC de Maximo no canceladas (estatus actual), con IVA, por mes de creación de la OC y por moneda; USD aparte, sin convertir. Incluye las que la integración pasó a SAP.',
      sap: 'Montos adjudicados = OC de SAP no canceladas (estatus actual), con IVA, por mes de creación de la OC y por moneda; USD aparte, sin convertir. Sin las OC que la integración creó desde Maximo: se cuentan en la página de Maximo.',
      todas:
        'Montos adjudicados = OC no canceladas (estatus actual), con IVA, por mes de creación de la OC y por moneda; USD aparte, sin convertir. Las OC de SAP creadas desde Maximo se cuentan una vez.',
    }),
    semana:
      'Semana de lunes a domingo; la etiqueta va de lunes a viernes, como el reporte de Jorge.',
  };
}

// ── Fechas ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

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

type Estado = 'cerrada' | 'cancelada' | 'abierta' | 'sin_oc';

interface EstadoAl {
  estado: Estado;
  /** Momento del cierre o la cancelación; null si sigue abierta / sin OC. */
  fecha: number | null;
  con_oc: boolean;
}

/**
 * Estado de la gestión en el instante `asOf`. Un evento fechado antes que la
 * solicitud (captura retroactiva) cuenta desde que se recibió.
 */
export function estadoAl(g: Gestion, asOf: number): EstadoAl {
  const recibida = g.recibida.getTime();
  const at = (d: Date | null) =>
    d === null ? null : Math.max(d.getTime(), recibida);
  const oc = at(g.primera_oc);
  if (oc !== null && oc <= asOf) {
    return { estado: 'cerrada', fecha: oc, con_oc: true };
  }
  const sinOc = at(g.cierre_sin_oc);
  if (sinOc !== null && sinOc <= asOf) {
    return { estado: 'cerrada', fecha: sinOc, con_oc: false };
  }
  const cancel = at(g.cancelada);
  if (cancel !== null && cancel <= asOf) {
    return { estado: 'cancelada', fecha: cancel, con_oc: false };
  }
  return {
    estado: g.sistema === 'maximo' ? 'sin_oc' : 'abierta',
    fecha: null,
    con_oc: false,
  };
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
    canceladas: 0,
    abiertas: 0,
    sin_oc: 0,
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

/** Cohortes de varios años al instante `asOf`, en una sola pasada. */
export function cohortes(
  gestiones: Gestion[],
  anios: number[],
  asOf: number,
): CohorteAnio[] {
  const acc = new Map(
    anios.map((anio) => [
      anio,
      { conteo: conteoVacio(), cierre: [] as number[], cancel: [] as number[] },
    ]),
  );
  for (const g of gestiones) {
    if (g.recibida.getTime() > asOf) continue;
    const entry = acc.get(g.recibida.getUTCFullYear());
    if (!entry) continue;
    const c = entry.conteo;
    c.recibidas += 1;
    const e = estadoAl(g, asOf);
    if (e.estado === 'cerrada') {
      c.cerradas += 1;
      if (!e.con_oc) {
        c.cerradas_sin_oc += 1;
      } else if (g.primera_oc) {
        const days = gestionDays(g.recibida, g.primera_oc);
        if (days !== null) entry.cierre.push(days);
      }
    } else if (e.estado === 'cancelada') {
      c.canceladas += 1;
      if (g.cancelada) {
        const days = gestionDays(g.recibida, g.cancelada);
        if (days !== null) entry.cancel.push(days);
      }
    } else if (e.estado === 'abierta') {
      c.abiertas += 1;
    } else {
      c.sin_oc += 1;
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
export function semanaStats(gestiones: Gestion[], lunes: Date): SemanaStats {
  const start = lunes.getTime();
  const end = start + WEEK_MS;
  const anio = lunes.getUTCFullYear();
  let nuevas = 0;
  let aproximadas = 0;
  let cerradas = 0;
  let anteriores = 0;
  let canceladas = 0;
  const cierre: number[] = [];
  const cancel: number[] = [];
  for (const g of gestiones) {
    const recibida = g.recibida.getTime();
    if (recibida >= start && recibida < end) {
      nuevas += 1;
      if (g.fecha_origen !== 'exacta') aproximadas += 1;
    }
    if (recibida >= end) continue;
    const e = estadoAl(g, end - 1);
    if (e.fecha === null || e.fecha < start) continue;
    if (e.estado === 'cerrada') {
      cerradas += 1;
      if (g.recibida.getUTCFullYear() < anio) anteriores += 1;
      if (e.con_oc && g.primera_oc) {
        const days = gestionDays(g.recibida, g.primera_oc);
        if (days !== null) cierre.push(days);
      }
    } else if (e.estado === 'cancelada') {
      canceladas += 1;
      if (g.cancelada) {
        const days = gestionDays(g.recibida, g.cancelada);
        if (days !== null) cancel.push(days);
      }
    }
  }
  return {
    lunes: isoDay(lunes),
    etiqueta: alViernes(lunes),
    nuevas,
    nuevas_aproximadas: aproximadas,
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

/** OC del año por mes de creación y por moneda, hasta `asOf`. */
export function montosAdjudicados(
  ordenes: OrdenMonto[],
  fuente: AvanceFuente,
  anio: number,
  asOf: number,
): MontosAnio {
  const corte = new Date(asOf);
  const ultimoMes = corte.getUTCFullYear() > anio ? 11 : corte.getUTCMonth();
  const meses = MESES_TITULO.slice(0, ultimoMes + 1).map((etiqueta, i) => ({
    mes: i + 1,
    etiqueta,
    montos: {} as Record<string, number>,
    ordenes: 0,
  }));
  const total: Record<string, number> = {};
  let count = 0;
  let migradas = 0;
  for (const o of ordenes) {
    if (!enFuente(o.sistema, fuente)) continue;
    if (o.fecha.getUTCFullYear() !== anio || o.fecha.getTime() > asOf) continue;
    // I3: la OC de SAP creada desde Maximo es de la gestión de Maximo
    if (o.contada_en_maximo) {
      if (fuente === 'sap') migradas += 1;
      continue;
    }
    const mes = meses[o.fecha.getUTCMonth()];
    if (!mes) continue;
    const moneda = o.moneda ?? SIN_MONEDA;
    mes.montos[moneda] = round2((mes.montos[moneda] ?? 0) + o.monto);
    mes.ordenes += 1;
    total[moneda] = round2((total[moneda] ?? 0) + o.monto);
    count += 1;
  }
  return {
    anio,
    monedas: ordenMonedas(Object.keys(total)),
    meses,
    total,
    ordenes: count,
    migradas_excluidas: migradas,
  };
}

// ── Página ──────────────────────────────────────────────────────────────

const fmtCount = (n: number) => n.toLocaleString('es-MX');

const plural = (n: number, uno: string, varios: string) =>
  `${fmtCount(n)} ${n === 1 ? uno : varios}`;

export function buildAvancePage(
  data: AvanceData,
  lunes: Date,
  fuente: AvanceFuente,
  generado: Date,
): AvancePage {
  const semanaInicio = mondayOf(lunes);
  const start = semanaInicio.getTime();
  const asOf = start + WEEK_MS - 1;
  const anio = semanaInicio.getUTCFullYear();
  const gestiones = data.gestiones.filter((g) => enFuente(g.sistema, fuente));

  const anios = [anio - 4, anio - 3, anio - 2, anio - 1, anio];
  const anual = cohortes(gestiones, anios, asOf);
  const actual = anual[anual.length - 1];
  const previo = anual[anual.length - 2];
  const semana = semanaStats(gestiones, semanaInicio);
  const ultimas = [3, 2, 1, 0].map((k) =>
    k === 0 ? semana : semanaStats(gestiones, new Date(start - k * WEEK_MS)),
  );

  const conSap = fuente !== 'maximo';
  const conMaximo = fuente !== 'sap';
  const cancelacionNota =
    fuente === 'maximo'
      ? 'No disponible: Maximo no envía el estatus de las solicitudes.'
      : fuente === 'todas'
        ? 'Solo SAP; Maximo no envía el estatus de las solicitudes.'
        : null;

  const porSistema: AvancePage['por_sistema'] = {};
  if (fuente === 'todas') {
    for (const sistema of ['sap', 'maximo'] as const) {
      const propias = gestiones.filter((g) => g.sistema === sistema);
      const [cohorte] = cohortes(propias, [anio], asOf);
      const sem = semanaStats(propias, semanaInicio);
      porSistema[sistema] = {
        recibidas_anio: cohorte.recibidas,
        nuevas_semana: sem.nuevas,
        cerradas_anio: cohorte.cerradas,
        cerradas_semana: sem.cerradas,
        dias_cierre: cohorte.dias_cierre,
      };
    }
  }

  const noDisponible: AvancePage['no_disponible'] = [];
  if (conMaximo) {
    noDisponible.push({
      dato: 'Solicitudes canceladas de Maximo',
      motivo:
        'Maximo no envía el estatus de las PR; las que no tienen OC salen como "sin OC".',
    });
    noDisponible.push({
      dato: 'Fecha de las PR de Maximo sin OC',
      motivo:
        'Maximo solo manda la fecha de la PR con su OC; las demás se ubican aproximadas.',
    });
  }
  if (fuente === 'maximo') {
    noDisponible.push({
      dato: 'Tiempo promedio de cancelación',
      motivo: 'Maximo no envía el estatus de las solicitudes.',
    });
  }

  const notas: string[] = [];
  if (conMaximo) notas.push(MAXIMO_NOTA_ESTANDAR);
  notas.push(
    'Montos con IVA por mes de creación de la OC; OC no canceladas; cada moneda aparte, sin convertir.',
  );
  if (fuente === 'todas') {
    notas.push(
      'Las OC de SAP creadas desde Maximo se cuentan una vez (en Maximo), igual que en el tablero.',
    );
  }
  const montos = montosAdjudicados(data.ordenes, fuente, anio, asOf);
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
    // desglose por sistema: SAP cerrada a mano / PR de Maximo hecha contrato
    const sinOc = { sap: 0, maximo: 0 };
    for (const g of gestiones) {
      const recibida = g.recibida.getTime();
      if (g.recibida.getUTCFullYear() !== anio || recibida > asOf) continue;
      const e = estadoAl(g, asOf);
      if (e.estado === 'cerrada' && !e.con_oc) sinOc[g.sistema] += 1;
    }
    const partes = [
      sinOc.sap > 0
        ? `${plural(sinOc.sap, 'solicitud de SAP cerrada', 'solicitudes de SAP cerradas')} a mano sin OC`
        : null,
      sinOc.maximo > 0
        ? `${plural(sinOc.maximo, 'PR de Maximo que se volvió', 'PR de Maximo que se volvieron')} contrato`
        : null,
    ].filter(Boolean);
    notas.push(`${partes.join(' y ')}: cuentan como cerradas, sin días.`);
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
  if (conMaximo && semana.nuevas_aproximadas > 0) {
    notas.push(
      `Nuevas de la semana: ${fmtCount(semana.nuevas_aproximadas)} PR de Maximo con fecha aproximada.`,
    );
  }
  if (conMaximo && data.maximo_sin_fecha > 0) {
    notas.push(
      data.maximo_sin_fecha === 1
        ? '1 PR de Maximo sin fecha ubicable queda fuera.'
        : `${fmtCount(data.maximo_sin_fecha)} PR de Maximo sin fecha ubicable quedan fuera.`,
    );
  }

  const domingo = addDays(semanaInicio, 6);
  return {
    semana: {
      lunes: isoDay(semanaInicio),
      viernes: isoDay(addDays(semanaInicio, 4)),
      domingo: isoDay(domingo),
      anio,
      etiqueta: etiquetaSemana(semanaInicio),
      corte: fechaLarga(domingo),
    },
    fuente: { clave: fuente, etiqueta: FUENTE_ETIQUETA[fuente] },
    avance: {
      recibidas_anio: actual.recibidas,
      nuevas_semana: semana.nuevas,
      nuevas_aproximadas: semana.nuevas_aproximadas,
      cerradas_anio: actual.cerradas,
      cerradas_semana: semana.cerradas,
      cerradas_semana_anteriores: semana.cerradas_anteriores,
      anio_anterior:
        semanaInicio.getUTCMonth() === 0
          ? {
              anio: anio - 1,
              abiertas: previo.abiertas,
              sin_oc: previo.sin_oc,
            }
          : null,
    },
    cierre: {
      anio: actual.dias_cierre,
      semanas: ultimas.map((s) => ({
        lunes: s.lunes,
        etiqueta: s.etiqueta,
        cerradas: s.cerradas,
        dias: s.dias_cierre,
      })),
    },
    cancelacion: {
      disponible: conSap,
      nota: cancelacionNota,
      anio: conSap ? actual.dias_cancelacion : null,
      semanas: conSap
        ? ultimas.map((s) => ({
            lunes: s.lunes,
            etiqueta: s.etiqueta,
            canceladas: s.canceladas,
            dias: s.dias_cancelacion,
          }))
        : [],
    },
    estado_anio: {
      recibidas: actual.recibidas,
      cerradas: actual.cerradas,
      cerradas_sin_oc: actual.cerradas_sin_oc,
      canceladas: actual.canceladas,
      abiertas: actual.abiertas,
      sin_oc: actual.sin_oc,
      atendidas: actual.atendidas,
      atendidas_pct: actual.atendidas_pct,
    },
    anual,
    montos,
    por_sistema: porSistema,
    no_disponible: noDisponible,
    notas,
    generado: generado.toISOString(),
  };
}
