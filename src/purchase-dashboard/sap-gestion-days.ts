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
  /** OC consideradas (con solicitud base sincronizada y fecha válida). */
  total: number;
  /** OC con solicitud base pero descartadas (sin fecha o negativas). */
  descartadas: number;
}

const MS_PER_DAY = 86_400_000;

export function sapGestionDays(
  orders: SapGestionPo[],
  requests: SapGestionRequest[],
): SapGestionResult {
  const requestDate = new Map<number, Date>();
  for (const r of requests) {
    if (r.doc_date) requestDate.set(r.doc_entry, r.doc_date);
  }
  let sum = 0;
  let total = 0;
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
    const days = (po.doc_date.getTime() - oldest) / MS_PER_DAY;
    if (days < 0) {
      descartadas += 1;
      continue;
    }
    sum += days;
    total += 1;
  }
  return {
    promedio_dias: total === 0 ? null : Math.round((sum / total) * 10) / 10,
    total,
    descartadas,
  };
}
