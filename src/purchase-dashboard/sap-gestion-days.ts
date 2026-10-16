/**
 * Bloque 2026-09-23 (D3) — Días de gestión de SAP según Ingrid: "desde que
 * nace la RQ (la liberan) hasta que genero la orden de compra; la fecha de
 * la OC es la fecha de cierre de la gestión".
 *
 *   días = doc_date de la OC − doc_date de su solicitud de pedido base
 *
 * Solo cuentan las OC que nacieron de una solicitud (`base_request_entries`
 * no vacío) y cuya solicitud está sincronizada. Con varias solicitudes base
 * se toma la MÁS ANTIGUA (la gestión empezó ahí). Negativos (OC fechada
 * antes que la solicitud: captura retroactiva) se descartan. Sin base → null,
 * nunca 0.
 *
 * Función pura para poder pinzarla con fixtures OC+solicitud.
 */

export interface SapGestionPo {
  doc_entry: number;
  doc_date: Date | null;
  base_request_entries: number[];
}

export interface SapGestionRequest {
  doc_entry: number;
  doc_date: Date | null;
}

export interface SapGestionResult {
  /** Promedio con 1 decimal; null = sin base. */
  promedio_dias: number | null;
  /**
   * G2 (2026-09-28): mediana con 1 decimal. Las OC capturadas meses
   * después sesgan el promedio; la mediana muestra el caso típico.
   */
  mediana_dias: number | null;
  /** OC consideradas (con solicitud base sincronizada y fecha válida). */
  total: number;
  /** OC con solicitud base pero descartadas (sin fecha o negativas). */
  descartadas: number;
}

const MS_PER_DAY = 86_400_000;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Promedio y mediana con 1 decimal; sin valores → null (nunca 0). */
export function averageAndMedian(values: number[]): {
  promedio_dias: number | null;
  mediana_dias: number | null;
} {
  if (values.length === 0) return { promedio_dias: null, mediana_dias: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return { promedio_dias: round1(avg), mediana_dias: round1(median) };
}

/**
 * Días de gestión de una solicitud: de su fecha a la de su OC (o al evento
 * que la cierra). Negativo (OC fechada antes que la solicitud: captura
 * retroactiva) → null, fuera del promedio. Misma cuenta para la tarjeta del
 * dashboard (G2, por OC) y el reporte de avance semanal (H1, por solicitud).
 */
export function gestionDays(from: Date, to: Date): number | null {
  const value = (to.getTime() - from.getTime()) / MS_PER_DAY;
  return value < 0 ? null : value;
}

/**
 * N2 (2026-10-16): los días de cada OC de SAP que entran en G2 (y cuántas se
 * descartan). `sapGestionDays` los resume; "Ambos" junta estos valores con
 * los de Maximo para sacar promedio y mediana de los días de cada OC.
 */
export function sapGestionValues(
  orders: SapGestionPo[],
  requests: SapGestionRequest[],
): { days: number[]; descartadas: number } {
  const requestDate = new Map<number, Date>();
  for (const r of requests) {
    if (r.doc_date) requestDate.set(r.doc_entry, r.doc_date);
  }
  const days: number[] = [];
  let descartadas = 0;
  for (const po of orders) {
    if (po.base_request_entries.length === 0) continue;
    const dates = po.base_request_entries
      .map((entry) => requestDate.get(entry))
      .filter((d): d is Date => d !== undefined);
    if (dates.length === 0 || !po.doc_date) {
      descartadas += 1;
      continue;
    }
    const oldest = Math.min(...dates.map((d) => d.getTime()));
    const value = gestionDays(new Date(oldest), po.doc_date);
    if (value === null) {
      descartadas += 1;
      continue;
    }
    days.push(value);
  }
  return { days, descartadas };
}

export function sapGestionDays(
  orders: SapGestionPo[],
  requests: SapGestionRequest[],
): SapGestionResult {
  const { days, descartadas } = sapGestionValues(orders, requests);
  return { ...averageAndMedian(days), total: days.length, descartadas };
}

export interface MaximoGestionResult extends SapGestionResult {
  /** OC sin solicitud (sin PR.ISSUEDATE): fuera del promedio. */
  sin_solicitud: number;
}

/**
 * G2 (2026-09-28) — Días de gestión de Maximo con la misma definición:
 * fecha de la OC (created_at_source) − fecha de creación de su solicitud
 * (PR.ISSUEDATE, la más antigua; `pr_issue_date` de la 0016 y, si la línea
 * no la trae, la de la PR en AB_CONTRATOS, K4.3). `dias` null = OC sin
 * solicitud; negativos (OC fechada antes que su PR) se descartan.
 */
/** N2: los días de cada OC de Maximo que entran en G2 (ver `sapGestionValues`). */
export function maximoGestionValues(rows: Array<{ dias: unknown }>): {
  days: number[];
  descartadas: number;
  sin_solicitud: number;
} {
  const days: number[] = [];
  let descartadas = 0;
  let sinSolicitud = 0;
  for (const row of rows) {
    if (row.dias === null || row.dias === undefined) {
      sinSolicitud += 1;
      continue;
    }
    const value = Number(row.dias);
    if (!Number.isFinite(value) || value < 0) {
      descartadas += 1;
      continue;
    }
    days.push(value);
  }
  return { days, descartadas, sin_solicitud: sinSolicitud };
}

export function maximoGestionDays(
  rows: Array<{ dias: unknown }>,
): MaximoGestionResult {
  const { days, descartadas, sin_solicitud } = maximoGestionValues(rows);
  return {
    ...averageAndMedian(days),
    total: days.length,
    descartadas,
    sin_solicitud,
  };
}

/**
 * K4.3 (2026-10-05) — G2 de Maximo con las dos fechas de `maximoGestionSql`
 * (erp-views): desde la creación de la PR (la definición de G2) y, como dato
 * secundario, desde su aprobación (primer APPR: llegada a Compras). En
 * `desde_aprobacion`, `sin_solicitud` = OC sin PR aprobada.
 */
export function maximoGestion(
  rows: Array<{ dias: unknown; dias_desde_aprobacion: unknown }>,
): { creacion: MaximoGestionResult; desde_aprobacion: MaximoGestionResult } {
  return {
    creacion: maximoGestionDays(rows),
    desde_aprobacion: maximoGestionDays(
      rows.map((r) => ({ dias: r.dias_desde_aprobacion })),
    ),
  };
}

export const SAP_GESTION_DEFINICION =
  'De la fecha de la solicitud de pedido (la más antigua) a la fecha de la OC; solo OC que nacieron de una solicitud de pedido en SAP';
export const MAXIMO_GESTION_DEFINICION =
  'De la fecha de creación de la solicitud (PR, la más antigua de la OC) a la fecha de la OC en Maximo; si la línea de la OC no trae la fecha de su PR, se toma la de la PR en Maximo (AB_CONTRATOS); solo OC con solicitud';
export const MAXIMO_GESTION_APROBACION_DEFINICION =
  'Dato secundario: de la aprobación de la solicitud (primer APPR de la PR, la más antigua de la OC: cuando llegó a Compras) a la fecha de la OC en Maximo; solo OC con PR aprobada';
