import { Prisma } from '@prisma/client';

/**
 * FP&A (B3) — flujo de aprobación de un presupuesto: de quién es el turno y
 * quién puede enviar, aprobar, rechazar, retirar o reabrir. Funciones puras,
 * sin base. Diseño: documentation/FPA.md, "Diseño" §3 y §4, y la reunión del
 * 26-oct (borrador › enviado › área › planeación › CFO; el rechazo vuelve a
 * captura y la ronda nueva empieza en el área).
 *
 * - Envía quien tiene la captura del área (titular o suplente). Planeación
 *   edita, pero no envía por el área (decisión 3).
 * - El paso del área lo firma quien tiene su aprobación (titular o suplente).
 *   Planeación y CFO: sus firmantes registrados (fpa_assignments sin área);
 *   sin firmantes, cualquiera con el rol (fpa_planeacion o fpa_cfo).
 * - Nadie firma lo que envió ni dos pasos de la misma ronda (decisión 11).
 * - Rechaza quien tiene el turno, siempre con comentario.
 * - Retira quien envió, antes de la primera firma de la ronda.
 * - Reabre planeación un presupuesto aprobado, con comentario, mientras la
 *   versión no esté cerrada.
 * - super_admin actúa en cualquier paso como soporte (queda dicho en el
 *   historial), con las mismas reglas de no firmar lo que envió ni dos pasos.
 */

export type BudgetStatus =
  | 'borrador'
  | 'enviado'
  | 'aprobado_area'
  | 'aprobado_planeacion'
  | 'aprobado_cfo'
  | 'devuelto';

export type Step = 'area' | 'planeacion' | 'cfo';

export type ActingAs = 'titular' | 'suplente' | 'rol' | 'super_admin';

export type FlowAction =
  | 'enviado'
  | 'aprobado'
  | 'rechazado'
  | 'retirado'
  | 'reabierto';

/** El paso que espera cada estado (null: no espera una firma). */
export const STEP_OF_STATUS: Record<BudgetStatus, Step | null> = {
  borrador: null,
  enviado: 'area',
  aprobado_area: 'planeacion',
  aprobado_planeacion: 'cfo',
  aprobado_cfo: null,
  devuelto: null,
};

/** A qué estado lleva aprobar cada paso. */
export const STATUS_AFTER: Record<Step, BudgetStatus> = {
  area: 'aprobado_area',
  planeacion: 'aprobado_planeacion',
  cfo: 'aprobado_cfo',
};

/** "el paso del área", "el paso de planeación", "el paso del CFO". */
export const STEP_OF: Record<Step, string> = {
  area: 'del área',
  planeacion: 'de planeación',
  cfo: 'del CFO',
};

/** El rol que firma cada paso general cuando no hay firmantes registrados. */
export const STEP_ROLE: Record<'planeacion' | 'cfo', string> = {
  planeacion: 'fpa_planeacion',
  cfo: 'fpa_cfo',
};

export interface FlowAssignment {
  profile_id: string;
  duty: string;
  area_id: string | null;
  is_alternate: boolean;
}

export interface FlowEvent {
  round: number;
  action: string;
  step: string | null;
  actor_profile_id: string;
}

export interface FlowActor {
  id: string;
  /** Roles efectivos (los de user_roles y el principal). */
  roles: string[];
}

export interface FlowState {
  status: BudgetStatus;
  round: number;
  version_status: string;
  area_id: string;
  /** Responsabilidades vigentes del área y los firmantes generales. */
  assignments: FlowAssignment[];
  /** Eventos del presupuesto (basta la ronda actual). */
  events: FlowEvent[];
  /** Líneas vivas del presupuesto. */
  line_count: number;
  /** ¿Alguna línea viva sale "No disponible"? (no se puede enviar) */
  has_unavailable: boolean;
}

/**
 * El derecho a actuar, o por qué no. `code` dice si el "no" es por el estado
 * (409: ya no se puede, para nadie) o por la persona (403: lo hace otra).
 */
export type Right =
  | { ok: true; acting_as: ActingAs; actor_role: string; step?: Step }
  | { ok: false; code: 'estado' | 'persona'; reason: string };

const byState = (reason: string): Right => ({
  ok: false,
  code: 'estado',
  reason,
});
const byPerson = (reason: string): Right => ({
  ok: false,
  code: 'persona',
  reason,
});

const FPA_ROLES = ['fpa_area', 'fpa_planeacion', 'fpa_cfo'];

const has = (actor: FlowActor, role: string) => actor.roles.includes(role);
const isSuper = (actor: FlowActor) => has(actor, 'super_admin');

/** El rol de FP&A con el que actúa: el del paso si lo tiene, si no el primero. */
const fpaRole = (actor: FlowActor, preferred?: string) =>
  preferred && has(actor, preferred)
    ? preferred
    : (FPA_ROLES.find((r) => has(actor, r)) ?? 'super_admin');

const asSuper = (step?: Step): Right => ({
  ok: true,
  acting_as: 'super_admin',
  actor_role: 'super_admin',
  ...(step ? { step } : {}),
});

const mine = (
  s: FlowState,
  actor: FlowActor,
  duty: string,
  areaId: string | null,
) =>
  s.assignments.find(
    (a) => a.profile_id === actor.id && a.duty === duty && a.area_id === areaId,
  );

/** Responsables vigentes de una función (con área, o generales si areaId es null). */
export const holders = (
  assignments: FlowAssignment[],
  duty: string,
  areaId: string | null,
) => assignments.filter((a) => a.duty === duty && a.area_id === areaId);

/** Quién envió la ronda actual (null si no hay envío en la ronda). */
export function senderOfRound(s: FlowState): string | null {
  const ev = s.events.find(
    (e) => e.round === s.round && e.action === 'enviado',
  );
  return ev?.actor_profile_id ?? null;
}

/** Pasos que ya firmó alguien en la ronda actual: actor por paso. */
export function signedInRound(s: FlowState): Map<Step, string> {
  const map = new Map<Step, string>();
  for (const e of s.events) {
    if (e.round === s.round && e.action === 'aprobado' && e.step) {
      map.set(e.step as Step, e.actor_profile_id);
    }
  }
  return map;
}

/** ¿Puede enviar (o reenviar) el presupuesto? */
export function canSubmit(actor: FlowActor, s: FlowState): Right {
  if (s.version_status !== 'captura') {
    return byState('La versión no está abierta a captura');
  }
  if (s.status !== 'borrador' && s.status !== 'devuelto') {
    return byState('El presupuesto ya está en aprobación o aprobado');
  }
  const a = mine(s, actor, 'captura', s.area_id);
  if (!a && !isSuper(actor)) {
    return byPerson('Solo quien captura el área lo envía');
  }
  if (s.line_count === 0) {
    return byState('No tiene líneas: captura al menos una antes de enviarlo');
  }
  if (s.has_unavailable) {
    return byState(
      'Hay líneas que salen "No disponible": falta un parámetro de la versión (avisa a planeación)',
    );
  }
  if (holders(s.assignments, 'aprobacion', s.area_id).length === 0) {
    return byState(
      'El área no tiene quien la apruebe: planeación lo registra en Áreas',
    );
  }
  if (a) {
    return {
      ok: true,
      acting_as: a.is_alternate ? 'suplente' : 'titular',
      actor_role: fpaRole(actor, 'fpa_area'),
    };
  }
  return asSuper();
}

/** ¿Puede decidir (aprobar o rechazar) el paso que espera el presupuesto? */
export function canDecide(actor: FlowActor, s: FlowState): Right {
  if (s.version_status !== 'captura') {
    return byState('La versión no está abierta a captura');
  }
  const step = STEP_OF_STATUS[s.status];
  if (!step) return byState('El presupuesto no espera una firma');

  if (senderOfRound(s) === actor.id) {
    return byPerson('Tú lo enviaste: lo firma otra persona');
  }
  for (const [otherStep, who] of signedInRound(s)) {
    if (otherStep !== step && who === actor.id) {
      return byPerson(
        `Ya firmaste el paso ${STEP_OF[otherStep]} en esta ronda: este lo firma otra persona`,
      );
    }
  }

  if (step === 'area') {
    const a = mine(s, actor, 'aprobacion', s.area_id);
    if (a) {
      return {
        ok: true,
        step,
        acting_as: a.is_alternate ? 'suplente' : 'titular',
        actor_role: fpaRole(actor, 'fpa_area'),
      };
    }
    if (isSuper(actor)) return asSuper(step);
    return byPerson('Lo firma quien aprueba el área');
  }

  const role = STEP_ROLE[step];
  const registered = holders(s.assignments, step, null);
  if (registered.length > 0) {
    const a = registered.find((r) => r.profile_id === actor.id);
    if (a) {
      return {
        ok: true,
        step,
        acting_as: a.is_alternate ? 'suplente' : 'titular',
        actor_role: fpaRole(actor, role),
      };
    }
    if (isSuper(actor)) return asSuper(step);
    return byPerson(`Lo firma el firmante ${STEP_OF[step]}`);
  }
  if (has(actor, role))
    return { ok: true, step, acting_as: 'rol', actor_role: role };
  if (isSuper(actor)) return asSuper(step);
  return byPerson(
    step === 'planeacion' ? 'Lo firma planeación' : 'Lo firma el CFO',
  );
}

/** ¿Puede retirar el envío (antes de la primera firma de la ronda)? */
export function canWithdraw(actor: FlowActor, s: FlowState): Right {
  if (s.status !== 'enviado') {
    return byState('Solo se retira un presupuesto enviado y sin firmas');
  }
  if (signedInRound(s).size > 0) {
    return byState('Ya tiene una firma: ya no se retira');
  }
  if (senderOfRound(s) !== actor.id) {
    return isSuper(actor)
      ? asSuper()
      : byPerson('Solo quien lo envió lo retira');
  }
  const a = mine(s, actor, 'captura', s.area_id);
  if (a) {
    return {
      ok: true,
      acting_as: a.is_alternate ? 'suplente' : 'titular',
      actor_role: fpaRole(actor, 'fpa_area'),
    };
  }
  if (isSuper(actor)) return asSuper();
  // Cambió el responsable después del envío: ya no actúa en el área
  return byPerson(
    'Ya no capturas esta área: lo puede rechazar quien la aprueba',
  );
}

/** ¿Puede reabrir un presupuesto aprobado? */
export function canReopen(actor: FlowActor, s: FlowState): Right {
  if (s.status !== 'aprobado_cfo') {
    return byState('Solo se reabre un presupuesto aprobado');
  }
  if (s.version_status === 'cerrada') {
    return byState('La versión está cerrada: ya no se reabre');
  }
  if (s.version_status !== 'captura') {
    return byState('La versión no está abierta a captura');
  }
  if (has(actor, 'fpa_planeacion')) {
    return { ok: true, acting_as: 'rol', actor_role: 'fpa_planeacion' };
  }
  if (isSuper(actor)) return asSuper();
  return byPerson('Solo planeación reabre un presupuesto aprobado');
}

/** De quién es el turno, para mostrar. */
export function turnLabel(status: BudgetStatus, round: number): string {
  switch (status) {
    case 'borrador':
      return round === 0
        ? 'En captura: nunca enviado'
        : 'Retirado: en captura otra vez';
    case 'devuelto':
      return 'Devuelto: lo corrige y lo reenvía quien captura';
    case 'enviado':
      return 'Turno de quien aprueba el área';
    case 'aprobado_area':
      return 'Turno de planeación';
    case 'aprobado_planeacion':
      return 'Turno del CFO';
    case 'aprobado_cfo':
      return 'Aprobado';
  }
}

// -----------------------------------------------------------------------------
// Qué cambió entre dos rondas (las fotos de sus envíos)
// -----------------------------------------------------------------------------

/** Lo que lee la comparación de cada línea de la foto. */
export interface SnapshotLine {
  line_key_id: string;
  folio: string;
  concept: string;
  total_mxn: string | null;
  months?: Array<{ month: number; amount_mxn: string | null }>;
  classification?: { name: string } | null;
  department?: { name: string } | null;
  supplier_name?: string | null;
  currency?: string;
}

export interface SnapshotBody {
  total_mxn: string | null;
  lines: SnapshotLine[];
}

export interface LineBrief {
  folio: string;
  concept: string;
  total_mxn: string | null;
}

export interface RoundChanges {
  total_before: string | null;
  total_after: string | null;
  /** Después − antes, en pesos (null si alguno no tiene total). */
  delta: string | null;
  added: LineBrief[];
  removed: LineBrief[];
  changed: Array<LineBrief & { total_before: string | null; fields: string[] }>;
}

const sub = (a: string | null, b: string | null): string | null =>
  a === null || b === null
    ? null
    : new Prisma.Decimal(a).minus(new Prisma.Decimal(b)).toFixed(2);

const sameAmount = (a: string | null, b: string | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    new Prisma.Decimal(a).equals(new Prisma.Decimal(b)));

const monthsKey = (l: SnapshotLine) =>
  (l.months ?? []).map((m) => `${m.month}:${m.amount_mxn ?? '-'}`).join('|');

const brief = (l: SnapshotLine): LineBrief => ({
  folio: l.folio,
  concept: l.concept,
  total_mxn: l.total_mxn,
});

/** Qué cambió de la foto de una ronda a la de la siguiente, por llave de línea. */
export function diffSnapshots(
  before: SnapshotBody,
  after: SnapshotBody,
): RoundChanges {
  const prev = new Map(before.lines.map((l) => [l.line_key_id, l]));
  const next = new Map(after.lines.map((l) => [l.line_key_id, l]));
  const added: LineBrief[] = [];
  const removed: LineBrief[] = [];
  const changed: RoundChanges['changed'] = [];
  for (const l of after.lines) {
    const old = prev.get(l.line_key_id);
    if (!old) {
      added.push(brief(l));
      continue;
    }
    const fields: string[] = [];
    if (old.concept !== l.concept) fields.push('Concepto');
    if (
      (old.classification?.name ?? null) !== (l.classification?.name ?? null)
    ) {
      fields.push('Clasificación');
    }
    if ((old.department?.name ?? null) !== (l.department?.name ?? null)) {
      fields.push('Departamento');
    }
    if ((old.supplier_name ?? null) !== (l.supplier_name ?? null)) {
      fields.push('Proveedor');
    }
    if ((old.currency ?? null) !== (l.currency ?? null)) fields.push('Moneda');
    if (!sameAmount(old.total_mxn, l.total_mxn)) fields.push('Monto');
    else if (monthsKey(old) !== monthsKey(l)) fields.push('Meses');
    if (fields.length > 0) {
      changed.push({ ...brief(l), total_before: old.total_mxn, fields });
    }
  }
  for (const l of before.lines) {
    if (!next.has(l.line_key_id)) removed.push(brief(l));
  }
  return {
    total_before: before.total_mxn,
    total_after: after.total_mxn,
    delta: sub(after.total_mxn, before.total_mxn),
    added,
    removed,
    changed,
  };
}
