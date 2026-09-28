import { averageAndMedian } from '../purchase-dashboard/sap-gestion-days';

/**
 * G5/G6 (reunión con Ingrid 2026-09-28) — Tiempos por aprobador con UNA
 * definición: días desde que el documento LE LLEGÓ al aprobador (no desde
 * que se creó), más lo que tiene pendiente hoy y su antigüedad. Así un
 * aprobador que aprueba rápido lo poco que aprueba pero tiene detenido lo
 * demás ya no sale como "el mejor" ("aquí parece que David es el mejor
 * aprobador y la verdad me tarda mucho").
 *
 *  - SAP (`sap_approval_requests.approvers`): le llega cuando decide la
 *    etapa anterior = la última aprobación de OTRA etapa hasta su decisión
 *    (o hasta hoy si está pendiente); en la primera etapa, la creación de la
 *    solicitud de autorización. Las fechas de decisión de SAP son por día.
 *  - Maximo (`maximo_po_status_history`, 0016): cada cambio a APPRn / APPR /
 *    APPRnREV / REVISD es una aprobación; le llegó con el cambio de estatus
 *    inmediato anterior. Pendiente hoy: la OC en WAPPR / APPRn / APPRnREV
 *    espera al siguiente nivel desde su último cambio (Maximo no dice a qué
 *    persona exacta le toca: eso sería el workflow, que no viene).
 *
 * Funciones puras: las usan el histórico por aprobador, la cadena de
 * Maximo, el Excel y la cola de SAP filtrada por aprobador.
 */

const MS_PER_DAY = 86_400_000;
/** Mismo día con fechas por día: diferencias de horas negativas cuentan 0. */
const SAME_DAY_TOLERANCE = 1;

const time = (value: string | Date | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? null : t;
};

/** Días entre dos instantes; negativos del mismo día → 0; más negativos → null. */
export function daysBetween(
  from: number | null,
  to: number | null,
): number | null {
  if (from === null || to === null) return null;
  const days = (to - from) / MS_PER_DAY;
  if (days < -SAME_DAY_TOLERANCE) return null;
  return Math.max(0, days);
}

// ── SAP ────────────────────────────────────────────────────────────────────

export interface SapApprovalLine {
  stage_code?: number | null;
  stage_name?: string | null;
  user_id?: number | null;
  user_name?: string | null;
  status?: string | null;
  update_date?: string | null;
}

export interface SapApprovalDoc {
  code: number;
  status: string | null;
  current_stage: number | null;
  creation_date: Date | null;
  approvers: SapApprovalLine[];
}

export type ApproverDecision = 'aprobada' | 'rechazada' | 'pendiente';

export interface ApproverEvent {
  usuario: string;
  decision: ApproverDecision;
  /** Decisión (aprobada/rechazada); null en pendientes. */
  at: number | null;
  /** Cuándo le llegó. */
  reached: number | null;
  /** Días con el aprobador (hasta su decisión o hasta hoy); null = sin fecha. */
  days: number | null;
  /** Maximo: nivel de la aprobación ("Nivel 1", "Aprobación final"…). */
  nivel?: string;
}

/** Cuándo le llegó la línea: última aprobación de OTRA etapa hasta su decisión. */
export function sapLineReachedAt(
  doc: SapApprovalDoc,
  line: SapApprovalLine,
): number | null {
  const until =
    line.status === 'ardPending'
      ? Number.POSITIVE_INFINITY
      : (time(line.update_date) ?? Number.POSITIVE_INFINITY);
  let reached: number | null = null;
  for (const other of doc.approvers) {
    if (other === line || other.status !== 'ardApproved') continue;
    if ((other.stage_code ?? null) === (line.stage_code ?? null)) continue;
    const t = time(other.update_date);
    if (t === null || t > until) continue;
    if (reached === null || t > reached) reached = t;
  }
  return reached ?? time(doc.creation_date);
}

/** ¿La línea pendiente es de la etapa actual (la que tiene el documento hoy)? */
function isCurrentStage(doc: SapApprovalDoc, line: SapApprovalLine): boolean {
  return (
    doc.current_stage === null ||
    line.stage_code === null ||
    line.stage_code === undefined ||
    line.stage_code === doc.current_stage
  );
}

export function sapApproverEvents(
  docs: SapApprovalDoc[],
  today: Date,
): ApproverEvent[] {
  const now = today.getTime();
  const events: ApproverEvent[] = [];
  for (const doc of docs) {
    for (const line of doc.approvers) {
      const usuario = line.user_name?.trim();
      if (!usuario) continue;
      if (line.status === 'ardApproved' || line.status === 'ardNotApproved') {
        const at = time(line.update_date);
        const reached = sapLineReachedAt(doc, line);
        events.push({
          usuario,
          decision: line.status === 'ardApproved' ? 'aprobada' : 'rechazada',
          at,
          reached,
          days: daysBetween(reached, at),
        });
      } else if (
        line.status === 'ardPending' &&
        doc.status === 'arsPending' &&
        isCurrentStage(doc, line)
      ) {
        const reached = sapLineReachedAt(doc, line);
        events.push({
          usuario,
          decision: 'pendiente',
          at: null,
          reached,
          days: daysBetween(reached, now),
        });
      }
    }
  }
  return events;
}

// ── Resumen por aprobador ──────────────────────────────────────────────────

export interface ApproverSummary {
  usuario: string;
  aprobadas: {
    total: number;
    dias_promedio: number | null;
    dias_mediana: number | null;
    dias_max: number | null;
  };
  /** null = el sistema no registra rechazos por aprobador (Maximo). */
  rechazadas: number | null;
  /** null = no se sabe a quién le toca (Maximo: se ve por nivel). */
  pendientes: {
    total: number;
    dias_promedio: number | null;
    dias_max: number | null;
  } | null;
  /** Maximo: niveles en los que aprobó en el periodo. */
  niveles?: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Aprobadas y rechazadas del periodo (por la fecha de su decisión) y
 * pendientes de hoy. `withPending`/`withRejected` = el sistema los registra.
 */
export function summarizeApprovers(
  events: ApproverEvent[],
  period: { from: Date; to: Date },
  options: { withPending: boolean; withRejected: boolean },
): ApproverSummary[] {
  const from = period.from.getTime();
  const to = period.to.getTime();
  const inPeriod = (e: ApproverEvent) =>
    e.at !== null && e.at >= from && e.at <= to;
  const byUser = new Map<string, ApproverEvent[]>();
  for (const e of events) {
    if (e.decision !== 'pendiente' && !inPeriod(e)) continue;
    byUser.set(e.usuario, [...(byUser.get(e.usuario) ?? []), e]);
  }
  const rows: ApproverSummary[] = [];
  for (const [usuario, list] of byUser) {
    const approved = list.filter((e) => e.decision === 'aprobada');
    const approvedDays = approved
      .map((e) => e.days)
      .filter((d): d is number => d !== null);
    const pending = list.filter((e) => e.decision === 'pendiente');
    // lo pendiente se cuenta en días completos (como la cola de SAP)
    const pendingDays = pending
      .map((e) => (e.days === null ? null : Math.floor(e.days)))
      .filter((d): d is number => d !== null);
    const stats = averageAndMedian(approvedDays);
    const niveles = [
      ...new Set(list.map((e) => e.nivel).filter((n): n is string => !!n)),
    ];
    rows.push({
      usuario,
      aprobadas: {
        total: approved.length,
        dias_promedio: stats.promedio_dias,
        dias_mediana: stats.mediana_dias,
        dias_max:
          approvedDays.length === 0 ? null : round1(Math.max(...approvedDays)),
      },
      rechazadas: options.withRejected
        ? list.filter((e) => e.decision === 'rechazada').length
        : null,
      pendientes: options.withPending
        ? {
            total: pending.length,
            dias_promedio: averageAndMedian(pendingDays).promedio_dias,
            dias_max:
              pendingDays.length === 0
                ? null
                : round1(Math.max(...pendingDays)),
          }
        : null,
      ...(niveles.length > 0 ? { niveles } : {}),
    });
  }
  return rows.sort(
    (a, b) =>
      (b.pendientes?.total ?? 0) - (a.pendientes?.total ?? 0) ||
      b.aprobadas.total - a.aprobadas.total ||
      a.usuario.localeCompare(b.usuario),
  );
}

// ── Maximo ─────────────────────────────────────────────────────────────────

const LEVEL = /^APPR(\d+)$/;
const LEVEL_REVISION = /^APPR(\d+)REV$/;

/** Nivel de una aprobación del historial POSTATUS; null si no es aprobación. */
export function maximoApprovalLevel(
  status: string | null,
): { key: string; label: string; order: number } | null {
  if (!status) return null;
  const level = LEVEL.exec(status);
  if (level) {
    const n = Number(level[1]);
    return { key: `N${n}`, label: `Nivel ${n}`, order: n };
  }
  const revision = LEVEL_REVISION.exec(status);
  if (revision) {
    const n = Number(revision[1]);
    return { key: `N${n}REV`, label: `Nivel ${n} (revisión)`, order: n + 0.5 };
  }
  if (status === 'APPR') {
    return { key: 'FINAL', label: 'Aprobación final', order: 100 };
  }
  if (status === 'REVISD') {
    return { key: 'REVISD', label: 'Revisión aprobada', order: 101 };
  }
  return null;
}

/** Nivel que espera una OC en aprobación (WAPPR / APPRn / APPRnREV). */
export function maximoPendingLevel(
  status: string | null,
): { nivel: number; etiqueta: string } | null {
  if (status === 'WAPPR') return { nivel: 1, etiqueta: 'Nivel 1' };
  const level = status ? LEVEL.exec(status) : null;
  if (level) {
    const next = Number(level[1]) + 1;
    return { nivel: next, etiqueta: `Nivel ${next} o aprobación final` };
  }
  const revision = status ? LEVEL_REVISION.exec(status) : null;
  if (revision) {
    const next = Number(revision[1]) + 1;
    return {
      nivel: next,
      etiqueta: `Nivel ${next} o aprobación final (revisión)`,
    };
  }
  return null;
}

export interface MaximoHistoryApproval {
  status: string;
  changed_by: string | null;
  change_date: Date | null;
  /** Fecha del cambio de estatus inmediato anterior (cuando le llegó). */
  prev_date: Date | null;
}

export function maximoApproverEvents(
  rows: MaximoHistoryApproval[],
): ApproverEvent[] {
  const events: ApproverEvent[] = [];
  for (const row of rows) {
    const level = maximoApprovalLevel(row.status);
    const usuario = row.changed_by?.trim();
    if (!level || !usuario) continue;
    const at = time(row.change_date);
    const reached = time(row.prev_date);
    events.push({
      usuario,
      decision: 'aprobada',
      at,
      reached,
      days: daysBetween(reached, at),
      nivel: level.label,
    });
  }
  return events;
}

export interface MaximoLevelTimes {
  nivel: string;
  aprobaciones: number;
  dias_promedio: number | null;
  dias_mediana: number | null;
}

/** Tiempos por nivel de la cadena (aprobaciones del periodo). */
export function summarizeMaximoLevels(
  rows: MaximoHistoryApproval[],
  period: { from: Date; to: Date },
): MaximoLevelTimes[] {
  const from = period.from.getTime();
  const to = period.to.getTime();
  const byLevel = new Map<
    string,
    { order: number; days: number[]; count: number }
  >();
  for (const row of rows) {
    const level = maximoApprovalLevel(row.status);
    const at = time(row.change_date);
    if (!level || at === null || at < from || at > to) continue;
    const entry = byLevel.get(level.label) ?? {
      order: level.order,
      days: [],
      count: 0,
    };
    entry.count += 1;
    const days = daysBetween(time(row.prev_date), at);
    if (days !== null) entry.days.push(days);
    byLevel.set(level.label, entry);
  }
  return [...byLevel.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([nivel, entry]) => {
      const stats = averageAndMedian(entry.days);
      return {
        nivel,
        aprobaciones: entry.count,
        dias_promedio: stats.promedio_dias,
        dias_mediana: stats.mediana_dias,
      };
    });
}
