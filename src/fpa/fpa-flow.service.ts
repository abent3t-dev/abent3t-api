import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type user_role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import {
  SocketService,
  type NotificationPayload,
} from '../socket/socket.service';
import { BusinessDaysService } from '../common/services/business-days.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { getEffectiveRoles, hasAnyRole } from '../common/utils/roles.util';
import { addDaysUtc, cdmxDateUtc } from '../contracts/contracts.dates';
import { FPA_ADMIN, FPA_SEE_ALL } from './fpa-roles';
import { FpaService } from './fpa.service';
import {
  STATUS_AFTER,
  STEP_OF,
  STEP_OF_STATUS,
  STEP_ROLE,
  canDecide,
  canReopen,
  canSubmit,
  canWithdraw,
  diffSnapshots,
  holders,
  senderOfRound,
  turnLabel,
  type BudgetStatus,
  type ActingAs,
  type FlowAction,
  type FlowActor,
  type FlowState,
  type Right,
  type SnapshotBody,
  type Step,
} from './fpa-flow';
import type { FpaFlowActionDto } from './dto/fpa-flow.dto';

/**
 * FP&A (B3) — flujo de aprobación de un presupuesto: enviar, aprobar (área,
 * planeación y CFO), rechazar con comentario, retirar y reabrir; la foto de
 * cada envío, la línea de tiempo por ronda con qué cambió, la bandeja de
 * pendientes, los avisos y el recordatorio diario. Diseño: documentation/
 * FPA.md, "Diseño" §3 y §4; reglas del turno en fpa-flow.ts.
 *
 * - Cada paso es una transacción: bloquea la versión (FOR SHARE: regresarla o
 *   cerrarla espera) y el presupuesto (FOR UPDATE), revisa el estado y la
 *   ronda que tenía la pantalla, resuelve el turno con los responsables
 *   vigentes, cambia el presupuesto y guarda el evento (solo inserción).
 * - Si otra persona ya lo movió, 409 con lo que pasó; si fue la misma persona
 *   con la misma acción (un reintento), cuenta como ya hecho.
 * - Fuera de turno, 403 "No es tu turno".
 * - Los avisos: el correo entra a la cola en la misma transacción (con la
 *   llave del presupuesto, la ronda y el paso) y el aviso en pantalla
 *   (user:{id}) sale al terminar. Nunca por sala de rol.
 */

type Db = Prisma.TransactionClient | PrismaService;
type Kind = 'submit' | 'approve' | 'reject' | 'withdraw' | 'reopen';

/** Presupuestos que esperan una firma. */
const IN_FLOW: BudgetStatus[] = [
  'enviado',
  'aprobado_area',
  'aprobado_planeacion',
];

/** Rechazar y reabrir piden por qué (como el CHECK de fpa_budget_events). */
const COMMENT_MIN = 10;

/** El recordatorio sale cuando el turno lleva más de estos días hábiles. */
const REMINDER_AFTER_DAYS = 2;

const ACTION_OF: Record<Kind, FlowAction> = {
  submit: 'enviado',
  approve: 'aprobado',
  reject: 'rechazado',
  withdraw: 'retirado',
  reopen: 'reabierto',
};

const STATUS_LABEL: Record<BudgetStatus, string> = {
  borrador: 'en borrador',
  enviado: 'enviado, en el turno de quien aprueba el área',
  aprobado_area: 'aprobado por el área, en el turno de planeación',
  aprobado_planeacion: 'aprobado por planeación, en el turno del CFO',
  aprobado_cfo: 'aprobado',
  devuelto: 'devuelto a captura',
};

const PERSON_SELECT = { id: true, full_name: true, email: true } as const;

const BUDGET_INCLUDE = {
  fpa_areas: { select: { id: true, name: true } },
  fpa_versions: {
    select: { id: true, code: true, name: true, status: true, is_active: true },
  },
} satisfies Prisma.fpa_budgetsInclude;

const ASSIGNMENT_INCLUDE = {
  profiles_fpa_assignments_profile_idToprofiles: { select: PERSON_SELECT },
} satisfies Prisma.fpa_assignmentsInclude;

/** El historial sin la foto (pesa): la foto solo la lee el detalle del flujo. */
const EVENT_SELECT = {
  id: true,
  budget_id: true,
  round: true,
  action: true,
  step: true,
  from_status: true,
  to_status: true,
  comment: true,
  actor_profile_id: true,
  actor_role: true,
  acting_as: true,
  total_mxn: true,
  created_at: true,
  profiles: { select: PERSON_SELECT },
} satisfies Prisma.fpa_budget_eventsSelect;

type BudgetRow = Prisma.fpa_budgetsGetPayload<{
  include: typeof BUDGET_INCLUDE;
}>;
type AssignmentRow = Prisma.fpa_assignmentsGetPayload<{
  include: typeof ASSIGNMENT_INCLUDE;
}>;
type EventRow = Prisma.fpa_budget_eventsGetPayload<{
  select: typeof EVENT_SELECT;
}>;

interface Loaded {
  budget: BudgetRow;
  assignments: AssignmentRow[];
  events: EventRow[];
}

interface Contact {
  id: string;
  full_name: string;
  email: string;
}

export interface Person {
  id: string;
  full_name: string;
}

export interface Check {
  ok: boolean;
  reason: string | null;
  /** Por qué no: el estado (para nadie) o la persona (le toca a otra). */
  code: 'estado' | 'persona' | null;
  /** Con qué derecho actuaría (la pantalla avisa cuando es como soporte). */
  acting_as: ActingAs | null;
}

/** Quién tiene el turno (o la captura) y puede actuar ahora. */
export interface Turn {
  step: Step | null;
  rule: 'registrados' | 'rol' | null;
  people: Array<Contact & { titular: boolean }>;
  /** Hay un paso pendiente y nadie de los responsables lo puede firmar. */
  blocked: boolean;
}

interface Notice {
  userId: string;
  payload: NotificationPayload;
}

const toContact = (p: {
  id: string;
  full_name: string | null;
  email: string;
}): Contact => ({
  id: p.id,
  full_name: p.full_name ?? p.email,
  email: p.email,
});

const toPerson = (p: {
  id: string;
  full_name: string | null;
  email: string;
}): Person => ({ id: p.id, full_name: p.full_name ?? p.email });

const actorOf = (user: AuthUser): FlowActor => ({
  id: user.id,
  roles: [...getEffectiveRoles(user)],
});

/** Texto para el HTML del correo (nombres y comentarios vienen de personas). */
const esc = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const frontendUrl = () =>
  process.env.FRONTEND_URL?.split(',')[0]?.trim() || 'http://localhost:3000';

const WHEN = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class FpaFlowService {
  private readonly logger = new Logger(FpaFlowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fpa: FpaService,
    private readonly email: EmailService,
    private readonly socket: SocketService,
    private readonly businessDays: BusinessDaysService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lectura del estado
  // ---------------------------------------------------------------------------

  private async load(db: Db, budgetId: string): Promise<Loaded> {
    const budget = await db.fpa_budgets.findFirst({
      where: { id: budgetId, is_active: true },
      include: BUDGET_INCLUDE,
    });
    if (!budget?.fpa_versions.is_active) {
      throw new NotFoundException('Presupuesto no encontrado');
    }
    const [assignments, events] = await Promise.all([
      db.fpa_assignments.findMany({
        where: {
          is_active: true,
          OR: [
            { area_id: budget.area_id },
            { area_id: null, duty: { in: ['planeacion', 'cfo'] } },
          ],
        },
        include: ASSIGNMENT_INCLUDE,
        orderBy: { created_at: 'asc' },
      }),
      db.fpa_budget_events.findMany({
        where: { budget_id: budgetId },
        select: EVENT_SELECT,
        orderBy: { created_at: 'asc' },
      }),
    ]);
    return { budget, assignments, events };
  }

  private state(
    l: Loaded,
    content: { line_count: number; has_unavailable: boolean } = {
      line_count: 0,
      has_unavailable: false,
    },
  ): FlowState {
    return {
      status: l.budget.status as BudgetStatus,
      round: l.budget.current_round,
      version_status: l.budget.fpa_versions.status,
      area_id: l.budget.area_id,
      assignments: l.assignments.map((a) => ({
        profile_id: a.profile_id,
        duty: a.duty,
        area_id: a.area_id,
        is_alternate: a.is_alternate,
      })),
      events: l.events.map((e) => ({
        round: e.round,
        action: e.action,
        step: e.step,
        actor_profile_id: e.actor_profile_id,
      })),
      ...content,
    };
  }

  /** Líneas y "No disponible": solo importan para enviar (borrador o devuelto). */
  private async content(db: Db, l: Loaded) {
    if (l.budget.status !== 'borrador' && l.budget.status !== 'devuelto') {
      return { line_count: 0, has_unavailable: false };
    }
    const snap = await this.fpa.budgetSnapshot(db, l.budget.id);
    return {
      line_count: snap.line_count,
      has_unavailable: snap.has_unavailable,
    };
  }

  /** Ve el flujo quien ve el presupuesto (como GET /fpa/presupuestos/:id). */
  private async assertCanSee(user: AuthUser, l: Loaded) {
    const seesAll = hasAnyRole(user, ...FPA_SEE_ALL);
    if (l.budget.fpa_versions.status === 'preparacion' && !seesAll) {
      throw new NotFoundException('Presupuesto no encontrado');
    }
    if (seesAll) return;
    const mine = await this.prisma.fpa_assignments.count({
      where: {
        profile_id: user.id,
        is_active: true,
        OR: [
          { area_id: l.budget.area_id },
          { area_id: null, duty: 'consulta' },
        ],
      },
    });
    if (mine === 0) {
      throw new ForbiddenException(
        'No tienes acceso al presupuesto de esta área',
      );
    }
  }

  /**
   * Quienes tienen hoy un rol: el de un paso general cuando no hay firmantes
   * registrados, planeación y soporte para un turno sin quien firme.
   */
  private async roleHolders(db: Db, role: string): Promise<Contact[]> {
    const rows = await db.user_roles.findMany({
      where: {
        role: role as user_role,
        is_active: true,
        profiles_user_roles_profile_idToprofiles: { is_active: true },
      },
      include: {
        profiles_user_roles_profile_idToprofiles: { select: PERSON_SELECT },
      },
    });
    return rows.map((r) =>
      toContact(r.profiles_user_roles_profile_idToprofiles),
    );
  }

  /** Roles vigentes (de FP&A y super_admin) de cada persona, para resolver el turno con los reales. */
  private async rolesOf(db: Db, ids: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (ids.length === 0) return map;
    const rows = await db.user_roles.findMany({
      where: {
        profile_id: { in: ids },
        is_active: true,
        OR: [{ module: 'fpa' }, { role: 'super_admin' }],
      },
      select: { profile_id: true, role: true },
    });
    for (const r of rows) {
      map.set(r.profile_id, [...(map.get(r.profile_id) ?? []), r.role]);
    }
    return map;
  }

  /**
   * De quién es el turno y quién puede actuar: en captura, quienes capturan
   * el área; en un paso, quienes lo pueden firmar en esta ronda (sin quien lo
   * envió ni quien firmó otro paso de la ronda).
   */
  private async turn(db: Db, s: FlowState, l: Loaded): Promise<Turn> {
    const fromAssignments = (duty: string, areaId: string | null) =>
      l.assignments
        .filter((a) => a.duty === duty && a.area_id === areaId)
        .map((a) => ({
          ...toContact(a.profiles_fpa_assignments_profile_idToprofiles),
          titular: !a.is_alternate,
        }));
    if (s.status === 'borrador' || s.status === 'devuelto') {
      return {
        step: null,
        rule: 'registrados',
        people: fromAssignments('captura', s.area_id),
        blocked: false,
      };
    }
    const step = STEP_OF_STATUS[s.status];
    if (!step) return { step: null, rule: null, people: [], blocked: false };
    let rule: 'registrados' | 'rol' = 'registrados';
    let candidates: Array<Contact & { titular: boolean }>;
    if (step === 'area') {
      candidates = fromAssignments('aprobacion', s.area_id);
    } else if (holders(s.assignments, step, null).length > 0) {
      candidates = fromAssignments(step, null);
    } else {
      rule = 'rol';
      candidates = (await this.roleHolders(db, STEP_ROLE[step])).map((c) => ({
        ...c,
        titular: true,
      }));
    }
    // Con sus roles reales: a quien le quitaron el rol del paso ya no le toca
    const roles = await this.rolesOf(
      db,
      candidates.map((c) => c.id),
    );
    const people = candidates.filter((c) => {
      const right = canDecide({ id: c.id, roles: roles.get(c.id) ?? [] }, s);
      return right.ok && right.acting_as !== 'super_admin';
    });
    return { step, rule, people, blocked: people.length === 0 };
  }

  /**
   * A quién avisar de un turno sin quien firme: planeación (registra otro
   * firmante o lo escala) y soporte (lo puede firmar).
   */
  private async unblockers(
    db: Db,
  ): Promise<{ email: Contact[]; screen: Contact[] }> {
    const [planeacion, soporte] = await Promise.all([
      this.roleHolders(db, 'fpa_planeacion'),
      this.roleHolders(db, 'super_admin'),
    ]);
    const screen = new Map<string, Contact>();
    for (const c of [...planeacion, ...soporte]) screen.set(c.id, c);
    return { email: planeacion, screen: [...screen.values()] };
  }

  /** A quién le llega el correo del turno: a los titulares; si ninguno puede, a los suplentes. */
  private emailTargets(t: Turn): Contact[] {
    if (t.rule === 'rol') return t.people;
    const titulars = t.people.filter((p) => p.titular);
    return titulars.length > 0 ? titulars : t.people;
  }

  /**
   * Días hábiles que lleva esperando, hora de México: los que siguen al día
   * en que llegó, hasta hoy (hoy cuenta aunque no haya terminado).
   */
  private async waitingDays(since: Date, now: Date): Promise<number> {
    const from = cdmxDateUtc(since);
    const to = cdmxDateUtc(now);
    if (to.getTime() <= from.getTime()) return 0;
    return this.businessDays.calculate(isoDay(addDaysUtc(from, 1)), isoDay(to));
  }

  private checks(actor: FlowActor, s: FlowState) {
    const c = (r: Right): Check =>
      r.ok
        ? { ok: true, reason: null, code: null, acting_as: r.acting_as }
        : { ok: false, reason: r.reason, code: r.code, acting_as: null };
    const decide = c(canDecide(actor, s));
    return {
      submit: c(canSubmit(actor, s)),
      approve: decide,
      reject: decide,
      withdraw: c(canWithdraw(actor, s)),
      reopen: c(canReopen(actor, s)),
    };
  }

  private eventDto(e: EventRow) {
    return {
      id: e.id,
      round: e.round,
      action: e.action,
      step: e.step,
      from_status: e.from_status,
      to_status: e.to_status,
      comment: e.comment,
      actor: toPerson(e.profiles),
      actor_role: e.actor_role,
      acting_as: e.acting_as,
      created_at: e.created_at.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // GET /fpa/presupuestos/:id/flujo y GET /fpa/pendientes
  // ---------------------------------------------------------------------------

  /** El flujo de un presupuesto: turno, qué puede hacer la persona y las rondas con qué cambió. */
  async flow(user: AuthUser, budgetId: string) {
    const l = await this.load(this.prisma, budgetId);
    await this.assertCanSee(user, l);
    const s = this.state(l, await this.content(this.prisma, l));
    const turn = await this.turn(this.prisma, s, l);
    const photos = await this.prisma.fpa_budget_events.findMany({
      where: { budget_id: budgetId, action: 'enviado' },
      select: { round: true, snapshot: true },
    });
    const photoOf = new Map(
      photos.map((p) => [
        p.round,
        p.snapshot as unknown as SnapshotBody | null,
      ]),
    );
    const rounds = [...new Set(l.events.map((e) => e.round))]
      .sort((a, b) => b - a)
      .map((round) => {
        const events = l.events.filter((e) => e.round === round);
        const sent = events.find((e) => e.action === 'enviado');
        const before = photoOf.get(round - 1);
        const after = photoOf.get(round);
        return {
          round,
          sent: sent
            ? {
                at: sent.created_at.toISOString(),
                by: toPerson(sent.profiles),
                acting_as: sent.acting_as,
                total_mxn: sent.total_mxn?.toFixed(2) ?? null,
                comment: sent.comment,
              }
            : null,
          events: events.map((e) => this.eventDto(e)),
          changes: before && after ? diffSnapshots(before, after) : null,
        };
      });
    return {
      budget: {
        id: l.budget.id,
        status: s.status,
        current_round: s.round,
        area: l.budget.fpa_areas,
        version: {
          id: l.budget.fpa_versions.id,
          code: l.budget.fpa_versions.code,
          name: l.budget.fpa_versions.name,
          status: l.budget.fpa_versions.status,
        },
      },
      turn: {
        step: turn.step,
        label: turnLabel(s.status, s.round),
        rule: turn.rule,
        who: turn.people.map((p) => ({
          id: p.id,
          full_name: p.full_name,
          is_alternate: !p.titular,
        })),
        blocked: turn.blocked,
      },
      actions: this.checks(actorOf(user), s),
      rounds,
    };
  }

  /**
   * La bandeja: lo que espera a la persona. Firmas (el paso que puede firmar
   * en esta ronda; no las de soporte) y devueltos de las áreas que captura.
   */
  async pending(user: AuthUser) {
    const budgets = await this.prisma.fpa_budgets.findMany({
      where: {
        is_active: true,
        status: { in: [...IN_FLOW, 'devuelto'] },
        fpa_versions: { is_active: true, status: 'captura' },
      },
      include: BUDGET_INCLUDE,
    });
    if (budgets.length === 0) return [];
    const areaIds = [...new Set(budgets.map((b) => b.area_id))];
    const [assignments, events] = await Promise.all([
      this.prisma.fpa_assignments.findMany({
        where: {
          is_active: true,
          OR: [
            { area_id: { in: areaIds } },
            { area_id: null, duty: { in: ['planeacion', 'cfo'] } },
          ],
        },
        include: ASSIGNMENT_INCLUDE,
      }),
      this.prisma.fpa_budget_events.findMany({
        where: { budget_id: { in: budgets.map((b) => b.id) } },
        select: EVENT_SELECT,
        orderBy: { created_at: 'asc' },
      }),
    ]);
    const actor = actorOf(user);
    // Planeación y soporte ven además los turnos que nadie puede firmar
    const unblocks = hasAnyRole(user, ...FPA_ADMIN);
    const now = new Date();
    const items = [];
    for (const budget of budgets) {
      const l: Loaded = {
        budget,
        assignments: assignments.filter(
          (a) => a.area_id === budget.area_id || a.area_id === null,
        ),
        events: events.filter((e) => e.budget_id === budget.id),
      };
      const s = this.state(l);
      let kind: 'firma' | 'devuelto' | 'bloqueado' | null = null;
      if (s.status === 'devuelto') {
        const captures = s.assignments.some(
          (a) =>
            a.profile_id === user.id &&
            a.duty === 'captura' &&
            a.area_id === s.area_id,
        );
        if (captures) kind = 'devuelto';
      } else {
        const r = canDecide(actor, s);
        if (r.ok && r.acting_as !== 'super_admin') kind = 'firma';
        else if (unblocks && (await this.turn(this.prisma, s, l)).blocked) {
          kind = 'bloqueado';
        }
      }
      if (!kind) continue;
      const round = l.events.filter((e) => e.round === s.round);
      const last = round[round.length - 1] ?? null;
      const sent = round.find((e) => e.action === 'enviado') ?? null;
      const since = last?.created_at ?? budget.updated_at;
      items.push({
        budget_id: budget.id,
        version: {
          id: budget.fpa_versions.id,
          code: budget.fpa_versions.code,
          name: budget.fpa_versions.name,
        },
        area: budget.fpa_areas,
        status: s.status,
        current_round: s.round,
        kind,
        step: STEP_OF_STATUS[s.status],
        since: since.toISOString(),
        business_days: await this.waitingDays(since, now),
        total_mxn: sent?.total_mxn?.toFixed(2) ?? null,
        sender: sent ? toPerson(sent.profiles) : null,
        last: last
          ? {
              action: last.action,
              step: last.step,
              actor: toPerson(last.profiles),
              comment: last.comment,
            }
          : null,
      });
    }
    return items.sort((a, b) => a.since.localeCompare(b.since));
  }

  // ---------------------------------------------------------------------------
  // Pasos del flujo
  // ---------------------------------------------------------------------------

  submit(user: AuthUser, id: string, dto: FpaFlowActionDto) {
    return this.act(user, id, 'submit', dto);
  }

  approve(user: AuthUser, id: string, dto: FpaFlowActionDto) {
    return this.act(user, id, 'approve', dto);
  }

  reject(user: AuthUser, id: string, dto: FpaFlowActionDto) {
    return this.act(user, id, 'reject', dto);
  }

  withdraw(user: AuthUser, id: string, dto: FpaFlowActionDto) {
    return this.act(user, id, 'withdraw', dto);
  }

  reopen(user: AuthUser, id: string, dto: FpaFlowActionDto) {
    return this.act(user, id, 'reopen', dto);
  }

  private rightFor(kind: Kind, actor: FlowActor, s: FlowState): Right {
    switch (kind) {
      case 'submit':
        return canSubmit(actor, s);
      case 'approve':
      case 'reject':
        return canDecide(actor, s);
      case 'withdraw':
        return canWithdraw(actor, s);
      case 'reopen':
        return canReopen(actor, s);
    }
  }

  /** 409 si es por el estado (ya no se puede); 403 si es por la persona. */
  private denial(kind: Kind, r: Extract<Right, { ok: false }>) {
    if (r.code === 'estado') return new ConflictException(r.reason);
    return new ForbiddenException(
      kind === 'approve' || kind === 'reject'
        ? `No es tu turno: ${r.reason}`
        : r.reason,
    );
  }

  /**
   * Un reintento: lo último que pasó es esta misma acción, de esta persona,
   * sobre el estado que tenía su pantalla. Si después pasó algo más, no es
   * "ya hecho": es un 409 con lo que pasó.
   */
  private alreadyDone(
    kind: Kind,
    dto: FpaFlowActionDto,
    events: EventRow[],
    userId: string,
  ): boolean {
    const last = events[events.length - 1];
    if (
      !last ||
      last.actor_profile_id !== userId ||
      last.action !== ACTION_OF[kind] ||
      last.from_status !== dto.expected_status
    ) {
      return false;
    }
    switch (kind) {
      case 'submit':
        return last.round === dto.expected_round + 1;
      case 'approve':
      case 'reject':
        return (
          last.round === dto.expected_round &&
          last.step === STEP_OF_STATUS[dto.expected_status]
        );
      case 'withdraw':
      case 'reopen':
        return last.round === dto.expected_round;
    }
  }

  /** Qué pasó mientras la pantalla tenía otro estado (para el 409). */
  private staleMessage(l: Loaded): string {
    const now =
      STATUS_LABEL[l.budget.status as BudgetStatus] ?? l.budget.status;
    const last = l.events[l.events.length - 1];
    if (!last)
      return `El presupuesto cambió: ahora está ${now}. Recarga la página`;
    const who = toPerson(last.profiles).full_name;
    const step = last.step ? STEP_OF[last.step as Step] : null;
    const what: Record<string, string> = {
      enviado: 'lo envió',
      aprobado: step ? `aprobó el paso ${step}` : 'lo aprobó',
      rechazado: step
        ? `lo regresó a captura en el paso ${step}`
        : 'lo regresó',
      retirado: 'lo retiró',
      reabierto: 'lo reabrió',
    };
    return `${who} ${what[last.action] ?? last.action} (${WHEN.format(last.created_at)}): ahora está ${now}. Recarga la página`;
  }

  private async act(
    user: AuthUser,
    budgetId: string,
    kind: Kind,
    dto: FpaFlowActionDto,
  ) {
    const comment = dto.comment?.trim() || null;
    if (
      (kind === 'reject' || kind === 'reopen') &&
      (comment ?? '').length < COMMENT_MIN
    ) {
      throw new BadRequestException(
        kind === 'reject'
          ? 'Escribe por qué lo regresas (al menos 10 caracteres)'
          : 'Escribe por qué se reabre (al menos 10 caracteres)',
      );
    }
    const head = await this.prisma.fpa_budgets.findFirst({
      where: { id: budgetId, is_active: true },
      select: { version_id: true },
    });
    if (!head) throw new NotFoundException('Presupuesto no encontrado');
    const actor = actorOf(user);
    const notices: Notice[] = [];
    await this.prisma.$transaction(
      async (tx) => {
        // La versión primero (regresarla o cerrarla espera a este paso) y
        // después el presupuesto (otro paso o una línea esperan)
        await tx.$queryRaw`SELECT id FROM fpa_versions WHERE id = ${head.version_id}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM fpa_budgets WHERE id = ${budgetId}::uuid FOR UPDATE`;
        const l = await this.load(tx, budgetId);
        const b = l.budget;
        if (
          b.status !== dto.expected_status ||
          b.current_round !== dto.expected_round
        ) {
          if (this.alreadyDone(kind, dto, l.events, user.id)) return;
          throw new ConflictException(this.staleMessage(l));
        }
        const photo =
          kind === 'submit'
            ? await this.fpa.budgetSnapshot(tx, budgetId)
            : null;
        const s = this.state(
          l,
          photo
            ? {
                line_count: photo.line_count,
                has_unavailable: photo.has_unavailable,
              }
            : undefined,
        );
        const right = this.rightFor(kind, actor, s);
        if (!right.ok) throw this.denial(kind, right);
        // Quienes podían decidir este paso (para quitarlo de sus bandejas)
        const decidable =
          kind === 'approve' || kind === 'reject'
            ? (await this.turn(tx, s, l)).people.map((p) => p.id)
            : [];

        const from = s.status;
        const step =
          kind === 'approve' || kind === 'reject' ? (right.step ?? null) : null;
        let to: BudgetStatus;
        let round = s.round;
        let data: Prisma.fpa_budgetsUpdateManyMutationInput;
        switch (kind) {
          case 'submit':
            to = 'enviado';
            round = s.round + 1;
            data = {
              status: to,
              current_round: round,
              submitted_at: new Date(),
            };
            break;
          case 'approve':
            to = STATUS_AFTER[step as Step];
            data = {
              status: to,
              ...(step === 'cfo' ? { approved_at: new Date() } : {}),
            };
            break;
          case 'reject':
            to = 'devuelto';
            data = { status: to };
            break;
          case 'withdraw':
            to = 'borrador';
            data = { status: to };
            break;
          case 'reopen':
            to = 'devuelto';
            data = { status: to, approved_at: null };
            break;
        }
        // UPDATE condicional (estado y ronda): con el FOR UPDATE no debería fallar
        const updated = await tx.fpa_budgets.updateMany({
          where: {
            id: budgetId,
            status: from,
            current_round: s.round,
            is_active: true,
          },
          data,
        });
        if (updated.count !== 1) {
          throw new ConflictException(
            'El presupuesto cambió mientras tanto: recarga la página',
          );
        }
        const event = await tx.fpa_budget_events.create({
          data: {
            budget_id: budgetId,
            round,
            action: ACTION_OF[kind],
            step,
            from_status: from,
            to_status: to,
            comment,
            actor_profile_id: user.id,
            actor_role: right.actor_role,
            acting_as: right.acting_as,
            snapshot: photo
              ? (photo.snapshot as unknown as Prisma.InputJsonObject)
              : Prisma.DbNull,
            total_mxn: photo ? photo.total_mxn : null,
          },
          select: EVENT_SELECT,
        });
        const after: Loaded = {
          budget: { ...b, status: to, current_round: round },
          assignments: l.assignments,
          events: [...l.events, event],
        };
        notices.push(
          ...(await this.notify(tx, kind, after, step, user, comment)),
        );
        // Los demás que podían decidir el paso (suplentes, otros del rol):
        // su bandeja y su contador se actualizan
        for (const pid of decidable) {
          if (pid !== user.id && !notices.some((n) => n.userId === pid)) {
            notices.push(
              this.screen(
                pid,
                after,
                `Ya se decidió el paso ${STEP_OF[step as Step]} en el presupuesto de ${b.fpa_areas.name} (${b.fpa_versions.code})`,
              ),
            );
          }
        }
      },
      { timeout: 20_000 },
    );
    for (const n of notices) {
      this.socket.emitToUser(n.userId, 'fpa:pending', n.payload);
    }
    return this.flow(user, budgetId);
  }

  // ---------------------------------------------------------------------------
  // Avisos y recordatorio
  // ---------------------------------------------------------------------------

  private async enqueue(
    tx: Prisma.TransactionClient | undefined,
    to: Contact,
    notice: { template: string; entityId: string },
    subject: string,
    lines: string[],
    budgetId: string,
  ) {
    const base = frontendUrl();
    const body = [
      `<p>Hola, <strong>${esc(to.full_name)}</strong>:</p>`,
      ...lines.map((line) => `<p>${line}</p>`),
      `<p><a href="${esc(`${base}/fpa/presupuestos/${budgetId}`)}">Abrir el presupuesto</a> · <a href="${esc(`${base}/fpa/pendientes`)}">Mis pendientes de FP&amp;A</a></p>`,
      '<p style="color:#666;font-size:12px">Mensaje automático de FP&amp;A, plataforma ABENT 3T.</p>',
    ].join('\n');
    await this.email.enqueue(
      {
        template: notice.template,
        entityType: 'fpa_budget',
        entityId: notice.entityId,
        to: { email: to.email, name: to.full_name },
        subject: subject.replace(/\s+/g, ' '),
        body,
        isHtml: true,
      },
      tx,
    );
  }

  private screen(userId: string, l: Loaded, message: string): Notice {
    return {
      userId,
      payload: {
        type: 'budget',
        action: 'pending_approval',
        entityId: l.budget.id,
        entityName: `${l.budget.fpa_areas.name} (${l.budget.fpa_versions.code})`,
        message,
        data: {
          module: 'fpa',
          status: l.budget.status,
          round: l.budget.current_round,
        },
      },
    };
  }

  /**
   * Avisos de un paso: al siguiente responsable (correo a los titulares, en
   * pantalla a todos los que pueden firmar), o a quien envió y a quien
   * captura cuando el presupuesto se aprueba, regresa o se reabre.
   */
  private async notify(
    tx: Prisma.TransactionClient,
    kind: Kind,
    l: Loaded,
    step: Step | null,
    user: AuthUser,
    comment: string | null,
  ): Promise<Notice[]> {
    const s = this.state(l);
    const id = l.budget.id;
    const what = `el presupuesto de ${l.budget.fpa_areas.name} (${l.budget.fpa_versions.code})`;
    const whatHtml = `el presupuesto de <strong>${esc(l.budget.fpa_areas.name)}</strong> (${esc(l.budget.fpa_versions.code)})`;
    const actorName = esc(user.full_name ?? user.email);
    const notices: Notice[] = [];

    // Quien envió la ronda y el titular de captura (sin quien actúa)
    const owners = (): Contact[] => {
      const out = new Map<string, Contact>();
      const sent = l.events.find(
        (e) => e.round === s.round && e.action === 'enviado',
      );
      if (sent) out.set(sent.actor_profile_id, toContact(sent.profiles));
      for (const a of l.assignments) {
        if (
          a.duty === 'captura' &&
          a.area_id === s.area_id &&
          !a.is_alternate
        ) {
          out.set(
            a.profile_id,
            toContact(a.profiles_fpa_assignments_profile_idToprofiles),
          );
        }
      }
      out.delete(user.id);
      return [...out.values()];
    };

    if (
      kind === 'submit' ||
      (kind === 'approve' && s.status !== 'aprobado_cfo')
    ) {
      const t = await this.turn(tx, s, l);
      const next = t.step as Step;
      if (t.blocked) {
        // Nadie de los responsables puede firmar: avisar a quien lo destraba
        const u = await this.unblockers(tx);
        const blockedLines = [
          `${actorName} ${kind === 'submit' ? 'envió' : 'aprobó'} ${whatHtml}, pero nadie de los responsables puede firmar el paso ${STEP_OF[next]} en esta ronda (nadie firma lo que envió ni dos pasos de la misma ronda).`,
          'Soporte lo puede firmar, o se registra otro firmante en Áreas.',
        ];
        for (const p of u.email) {
          await this.enqueue(
            tx,
            p,
            {
              template: 'fpa_bloqueado',
              entityId: `${id}:r${s.round}:${next}`,
            },
            `[ABENT 3T] FP&A: nadie puede firmar el paso ${STEP_OF[next]} en ${what}`,
            blockedLines,
            id,
          );
        }
        for (const p of u.screen) {
          notices.push(
            this.screen(
              p.id,
              l,
              `Nadie puede firmar el paso ${STEP_OF[next]} en ${what}`,
            ),
          );
        }
        return notices;
      }
      const lines = [
        `${actorName} ${kind === 'submit' ? 'envió' : 'aprobó'} ${whatHtml}${s.round > 1 && kind === 'submit' ? ` (ronda ${s.round})` : ''}. Sigue el paso ${STEP_OF[next]}, que te toca.`,
      ];
      for (const p of this.emailTargets(t)) {
        await this.enqueue(
          tx,
          p,
          { template: 'fpa_turno', entityId: `${id}:r${s.round}:${next}` },
          `[ABENT 3T] FP&A: ${what} espera tu firma`,
          lines,
          id,
        );
      }
      for (const p of t.people) {
        notices.push(this.screen(p.id, l, `Te toca firmar ${what}`));
      }
      return notices;
    }

    if (kind === 'approve') {
      for (const p of owners()) {
        await this.enqueue(
          tx,
          p,
          { template: 'fpa_aprobado', entityId: `${id}:r${s.round}:aprobado` },
          `[ABENT 3T] FP&A: ${what} quedó aprobado`,
          [`${actorName} dio la aprobación final (CFO) de ${whatHtml}.`],
          id,
        );
        notices.push(this.screen(p.id, l, `Se aprobó ${what}`));
      }
      return notices;
    }

    if (kind === 'reject' || kind === 'reopen') {
      const lines = [
        kind === 'reject'
          ? `${actorName} regresó ${whatHtml} a captura en el paso ${STEP_OF[step as Step]}.`
          : `${actorName} reabrió ${whatHtml}, que ya estaba aprobado: regresa a captura.`,
        `<em>${esc(comment ?? '')}</em>`,
        'Corrígelo y vuelve a enviarlo: el flujo empieza otra vez en el área.',
      ];
      const template = kind === 'reject' ? 'fpa_devuelto' : 'fpa_reabierto';
      const subject =
        kind === 'reject'
          ? `[ABENT 3T] FP&A: ${what} regresó a captura`
          : `[ABENT 3T] FP&A: ${what} se reabrió`;
      for (const p of owners()) {
        await this.enqueue(
          tx,
          p,
          {
            template,
            entityId: `${id}:r${s.round}:${step ?? ACTION_OF[kind]}`,
          },
          subject,
          lines,
          id,
        );
        notices.push(
          this.screen(
            p.id,
            l,
            kind === 'reject'
              ? `Regresó a captura ${what}`
              : `Se reabrió ${what}`,
          ),
        );
      }
      return notices;
    }

    // Retirado: a quien lo iba a aprobar se le quita de la bandeja (solo en pantalla)
    for (const a of l.assignments) {
      if (a.duty === 'aprobacion' && a.area_id === s.area_id) {
        notices.push(this.screen(a.profile_id, l, `Se retiró ${what}`));
      }
    }
    return notices;
  }

  /**
   * Recordatorio diario (en día hábil): a quien tiene un turno de firma que
   * lleva más de 2 días hábiles. Un correo por persona, presupuesto, ronda,
   * paso y día (la llave de la cola). Nunca revienta.
   */
  async runReminderCheck(now: Date = new Date()) {
    const result = { checked: 0, reminded: 0, errors: [] as string[] };
    const today = isoDay(cdmxDateUtc(now));
    if ((await this.businessDays.calculate(today, today)) === 0) return result;
    const budgets = await this.prisma.fpa_budgets.findMany({
      where: {
        is_active: true,
        status: { in: IN_FLOW },
        fpa_versions: { is_active: true, status: 'captura' },
      },
      select: { id: true },
    });
    result.checked = budgets.length;
    for (const { id } of budgets) {
      try {
        const l = await this.load(this.prisma, id);
        const s = this.state(l);
        const round = l.events.filter((e) => e.round === s.round);
        const since =
          round[round.length - 1]?.created_at ?? l.budget.updated_at;
        const days = await this.waitingDays(since, now);
        if (days <= REMINDER_AFTER_DAYS) continue;
        const t = await this.turn(this.prisma, s, l);
        const step = t.step as Step;
        const what = `el presupuesto de ${l.budget.fpa_areas.name} (${l.budget.fpa_versions.code})`;
        const whatHtml = `el presupuesto de <strong>${esc(l.budget.fpa_areas.name)}</strong> (${esc(l.budget.fpa_versions.code)})`;
        const sender = senderOfRound(s);
        const sentBy = sender
          ? l.events.find((e) => e.round === s.round && e.action === 'enviado')
              ?.profiles
          : null;
        // Sin quien firme, el recordatorio va a planeación (lo destraba)
        const targets = t.blocked
          ? (await this.unblockers(this.prisma)).email
          : this.emailTargets(t);
        for (const p of targets) {
          await this.enqueue(
            undefined,
            p,
            {
              template: 'fpa_recordatorio',
              entityId: `${id}:r${s.round}:${step}${t.blocked ? ':bloqueado' : ''}`,
            },
            t.blocked
              ? `[ABENT 3T] Recordatorio FP&A: nadie puede firmar el paso ${STEP_OF[step]} en ${what} (${days} días hábiles)`
              : `[ABENT 3T] Recordatorio FP&A: ${what} lleva ${days} días hábiles esperando tu firma`,
            [
              t.blocked
                ? `El paso ${STEP_OF[step]} en ${whatHtml} lleva ${days} días hábiles sin quien lo pueda firmar (nadie firma lo que envió ni dos pasos de la misma ronda). Soporte lo puede firmar, o se registra otro firmante en Áreas.`
                : `El paso ${STEP_OF[step]} en ${whatHtml} lleva ${days} días hábiles esperando tu firma${sentBy ? ` (lo envió ${esc(toPerson(sentBy).full_name)})` : ''}.`,
            ],
            id,
          );
        }
        if (targets.length > 0) result.reminded += 1;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${id}: ${msg}`);
      }
    }
    if (result.reminded > 0 || result.errors.length > 0) {
      this.logger.log(
        `Recordatorios de FP&A: revisados=${result.checked} enviados=${result.reminded} errores=${result.errors.length}`,
      );
    }
    return result;
  }
}
