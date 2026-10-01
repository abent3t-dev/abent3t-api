import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { cdmxDateUtc } from '../contracts/contracts.dates';
import { EmailTransportService } from './email-transport.service';

/**
 * J1 (hilo con César, 2026-10-01) — Cola y bitácora de TODOS los correos de
 * la plataforma: avisos de contratos, expeditación, comité y recordatorios de
 * capacitación. Nadie envía directo: se encola aquí y el worker
 * (EmailOutboxWorker) saca de uno en uno.
 *
 *  - Idempotencia: llave plantilla + entidad + destinatario + día (CDMX),
 *    UNIQUE. El mismo aviso dos veces el mismo día es un solo registro.
 *  - Solo destinatarios internos: el dominio de `ALLOWED_EMAIL_DOMAIN` (el
 *    mismo del login; default abent3t.com). Lo demás queda registrado como
 *    "rechazado" y no sale.
 *  - Ritmo: un correo cada `EMAIL_MIN_INTERVAL_SECONDS` (default 120, lo que
 *    pidió César).
 *  - Tope diario `EMAIL_DAILY_CAP` (default 100): al llegar, el envío se
 *    pausa solo y lo que falte sale al día siguiente; la app lo avisa a
 *    super_admin y lider_procura (`GET /correo/estado`).
 *  - Pausa manual: interruptor en BD (`email_settings`), sin deploy.
 *  - En simulación (default del transporte) el correo queda "simulado".
 *  - Error de envío: hasta 3 intentos con espera creciente; después "error".
 */

export const OUTBOX_STATUSES = [
  'pendiente',
  'enviando',
  'enviado',
  'simulado',
  'error',
  'rechazado',
] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const DEFAULT_MIN_INTERVAL_SECONDS = 120;
export const DEFAULT_DAILY_CAP = 100;
export const DEFAULT_ALLOWED_DOMAIN = 'abent3t.com';
export const MAX_ATTEMPTS = 3;
/** Espera antes de reintentar: 5 min × intento. */
export const RETRY_DELAY_MS = 5 * 60_000;

/** México no tiene horario de verano desde 2022: CDMX = UTC-6. */
const CDMX_OFFSET_MS = 6 * 3_600_000;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Instante en que empezó el día civil de CDMX de `now`. */
export function cdmxDayStart(now: Date): Date {
  return new Date(cdmxDateUtc(now).getTime() + CDMX_OFFSET_MS);
}

export interface EnqueueEmailInput {
  /** Plantilla o tipo de aviso: contract_digest, expediting_critica… */
  template: string;
  entityType?: string | null;
  entityId?: string | null;
  to: { email: string; name?: string | null };
  subject: string;
  body: string;
  isHtml?: boolean;
  /** Instante del aviso (default: ahora). Define el día de la llave. */
  at?: Date;
}

export interface EnqueueResult {
  /** `duplicado` = ese mismo aviso ya estaba hoy (no se vuelve a encolar). */
  status: 'pendiente' | 'rechazado' | 'duplicado';
  key: string;
}

export type ProcessOutcome =
  | 'enviado'
  | 'simulado'
  | 'reintento'
  | 'error'
  | 'rechazado'
  | 'pausado'
  | 'tope'
  | 'ritmo'
  | 'vacio';

export interface ProcessResult {
  outcome: ProcessOutcome;
  id?: string;
  error?: string;
}

export interface EmailQueueState {
  /** activo | pausado (interruptor) | tope (se alcanzó el tope del día). */
  state: 'activo' | 'pausado' | 'tope';
  paused: boolean;
  paused_reason: string | null;
  paused_at: Date | null;
  paused_by: { id: string; full_name: string | null } | null;
  transport: {
    mode: string;
    from: string;
    ready: boolean;
    missing: string[];
  };
  daily_cap: number;
  sent_today: number;
  min_interval_seconds: number;
  allowed_domains: string[];
  pending: number;
  errors_today: number;
  rejected_today: number;
  /** Cuándo puede salir el siguiente (por el ritmo); null = ya. */
  next_send_after: Date | null;
}

export interface OutboxListQuery {
  status?: string;
  template?: string;
  search?: string;
  desde?: string;
  hasta?: string;
  page?: number;
  limit?: number;
}

const LIST_SELECT = {
  id: true,
  template: true,
  entity_type: true,
  entity_id: true,
  recipient_email: true,
  recipient_name: true,
  subject: true,
  status: true,
  attempts: true,
  last_error: true,
  transport: true,
  provider_message_id: true,
  created_at: true,
  scheduled_at: true,
  last_attempt_at: true,
  sent_at: true,
} as const;

@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger('Email:cola');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly transport: EmailTransportService,
  ) {}

  // ── Configuración ───────────────────────────────────────────────────────

  get minIntervalMs(): number {
    return (
      this.positive(
        'EMAIL_MIN_INTERVAL_SECONDS',
        DEFAULT_MIN_INTERVAL_SECONDS,
      ) * 1000
    );
  }

  get dailyCap(): number {
    return this.positive('EMAIL_DAILY_CAP', DEFAULT_DAILY_CAP);
  }

  /**
   * `ALLOWED_EMAIL_DOMAIN`: el MISMO dominio único del login (OIDC compara
   * `@dominio` exacto), así que no admite lista: una lista rompería el login.
   */
  get allowedDomains(): string[] {
    const domain = (this.config.get<string>('ALLOWED_EMAIL_DOMAIN') ?? '')
      .trim()
      .toLowerCase()
      .replace(/^@/, '');
    return [domain || DEFAULT_ALLOWED_DOMAIN];
  }

  /** Dirección con un solo `@` y exactamente el dominio permitido. */
  isAllowedRecipient(email: string): boolean {
    const parts = email.trim().toLowerCase().split('@');
    if (parts.length !== 2 || !parts[0]) return false;
    return this.allowedDomains.includes(parts[1]);
  }

  private positive(name: string, fallback: number): number {
    const value = Number(this.config.get<string | number>(name));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  // ── Encolar ─────────────────────────────────────────────────────────────

  /** plantilla:tipo:id:destinatario:día — el mismo aviso del día es uno. */
  static idempotencyKey(
    input: Pick<EnqueueEmailInput, 'template' | 'entityType' | 'entityId'>,
    email: string,
    day: string,
  ): string {
    return [
      input.template,
      input.entityType ?? '-',
      input.entityId ?? '-',
      email,
      day,
    ]
      .join(':')
      .slice(0, 400);
  }

  /**
   * Registra el correo en la cola. Dentro de una transacción del llamador
   * (`tx`) el alta es atómica con su registro de negocio; el duplicado se
   * resuelve con ON CONFLICT DO NOTHING, así nunca rompe esa transacción.
   */
  async enqueue(
    input: EnqueueEmailInput,
    tx?: Prisma.TransactionClient,
  ): Promise<EnqueueResult> {
    const client = tx ?? this.prisma;
    const email = input.to.email.trim().toLowerCase();
    const day = isoDay(cdmxDateUtc(input.at ?? new Date()));
    const key = EmailOutboxService.idempotencyKey(input, email, day);
    const allowed = this.isAllowedRecipient(email);
    const { count } = await client.email_outbox.createMany({
      data: [
        {
          idempotency_key: key,
          template: input.template.slice(0, 60),
          entity_type: input.entityType?.slice(0, 40) ?? null,
          entity_id: input.entityId?.slice(0, 120) ?? null,
          recipient_email: email,
          recipient_name: input.to.name ?? null,
          subject: input.subject.slice(0, 500),
          body: input.body,
          is_html: input.isHtml ?? true,
          status: allowed ? 'pendiente' : 'rechazado',
          last_error: allowed
            ? null
            : `Destinatario fuera del dominio permitido (${this.allowedDomains.map((d) => `@${d}`).join(', ')})`,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return { status: 'duplicado', key };
    if (!allowed) {
      this.logger.warn(`Correo rechazado (dominio externo): ${email}`);
    }
    return { status: allowed ? 'pendiente' : 'rechazado', key };
  }

  // ── Worker: uno a la vez ────────────────────────────────────────────────

  /**
   * Saca UN correo si se puede: sin pausa, bajo el tope del día y respetando
   * el ritmo. El reloj es inyectable para las pruebas.
   */
  async processNext(now: Date = new Date()): Promise<ProcessResult> {
    const settings = await this.settings();
    if (settings.paused) return { outcome: 'pausado' };

    const sentToday = await this.sentToday(now);
    if (sentToday >= this.dailyCap) return { outcome: 'tope' };

    const lastAttempt = await this.lastAttemptAt();
    if (
      lastAttempt &&
      now.getTime() - lastAttempt.getTime() < this.minIntervalMs
    ) {
      return { outcome: 'ritmo' };
    }

    const next = await this.prisma.email_outbox.findFirst({
      where: { status: 'pendiente', scheduled_at: { lte: now } },
      orderBy: [{ scheduled_at: 'asc' }, { created_at: 'asc' }],
    });
    if (!next) return { outcome: 'vacio' };
    // Se toma solo si sigue pendiente (otro proceso no lo agarró)
    const claimed = await this.prisma.email_outbox.updateMany({
      where: { id: next.id, status: 'pendiente' },
      data: {
        status: 'enviando',
        attempts: { increment: 1 },
        last_attempt_at: now,
      },
    });
    if (claimed.count === 0) return { outcome: 'vacio' };

    // Defensa en profundidad: el dominio se revisa también al enviar
    if (!this.isAllowedRecipient(next.recipient_email)) {
      await this.prisma.email_outbox.update({
        where: { id: next.id },
        data: {
          status: 'rechazado',
          last_error: 'Destinatario fuera del dominio permitido',
        },
      });
      return { outcome: 'rechazado', id: next.id };
    }

    try {
      const delivery = await this.transport.deliver({
        to: { email: next.recipient_email, name: next.recipient_name },
        subject: next.subject,
        body: next.body,
        isHtml: next.is_html,
      });
      await this.prisma.email_outbox.update({
        where: { id: next.id },
        data: {
          status: delivery.status,
          sent_at: now,
          transport: delivery.transport,
          provider_message_id: delivery.messageId.slice(0, 255),
          last_error: null,
        },
      });
      if (sentToday + 1 >= this.dailyCap) {
        this.logger.warn(
          `Tope diario de correo alcanzado (${this.dailyCap}): el resto sale mañana`,
        );
      }
      return { outcome: delivery.status, id: next.id };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = next.attempts + 1;
      const final = attempts >= MAX_ATTEMPTS;
      await this.prisma.email_outbox.update({
        where: { id: next.id },
        data: {
          status: final ? 'error' : 'pendiente',
          last_error: message.slice(0, 1000),
          transport: this.transport.mode,
          ...(final
            ? {}
            : {
                scheduled_at: new Date(
                  now.getTime() + RETRY_DELAY_MS * attempts,
                ),
              }),
        },
      });
      this.logger.error(
        `Envío fallido (${attempts}/${MAX_ATTEMPTS}) a ${next.recipient_email}: ${message}`,
      );
      return {
        outcome: final ? 'error' : 'reintento',
        id: next.id,
        error: message,
      };
    }
  }

  /**
   * Al arrancar: lo que quedó "enviando" (proceso caído a la mitad) vuelve a
   * pendiente. Con una sola instancia del api no hay otro worker en vuelo.
   */
  async releaseStuck(): Promise<number> {
    const { count } = await this.prisma.email_outbox.updateMany({
      where: { status: 'enviando' },
      data: { status: 'pendiente' },
    });
    if (count > 0) {
      this.logger.warn(
        `${count} correo(s) en "enviando" volvieron a pendiente`,
      );
    }
    return count;
  }

  // ── Estado, pausa y bitácora ────────────────────────────────────────────

  async status(now: Date = new Date()): Promise<EmailQueueState> {
    const dayStart = cdmxDayStart(now);
    const [
      settings,
      sentToday,
      lastAttempt,
      pending,
      errorsToday,
      rejectedToday,
    ] = await Promise.all([
      this.settings(),
      this.sentToday(now),
      this.lastAttemptAt(),
      this.prisma.email_outbox.count({
        where: { status: { in: ['pendiente', 'enviando'] } },
      }),
      this.prisma.email_outbox.count({
        where: { status: 'error', updated_at: { gte: dayStart } },
      }),
      this.prisma.email_outbox.count({
        where: { status: 'rechazado', created_at: { gte: dayStart } },
      }),
    ]);
    const pausedBy = settings.paused_by
      ? await this.prisma.profiles.findFirst({
          where: { id: settings.paused_by },
          select: { id: true, full_name: true },
        })
      : null;
    const cap = this.dailyCap;
    const next = lastAttempt
      ? new Date(lastAttempt.getTime() + this.minIntervalMs)
      : null;
    return {
      state: settings.paused ? 'pausado' : sentToday >= cap ? 'tope' : 'activo',
      paused: settings.paused,
      paused_reason: settings.paused_reason,
      paused_at: settings.paused_at,
      paused_by: pausedBy,
      transport: this.transport.info(),
      daily_cap: cap,
      sent_today: sentToday,
      min_interval_seconds: this.minIntervalMs / 1000,
      allowed_domains: this.allowedDomains,
      pending,
      errors_today: errorsToday,
      rejected_today: rejectedToday,
      next_send_after: next && next > now ? next : null,
    };
  }

  /** Interruptor "Pausar envíos" (super_admin): en BD, sin deploy. */
  async setPaused(
    paused: boolean,
    userId: string,
    reason?: string | null,
  ): Promise<EmailQueueState> {
    await this.prisma.email_settings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        paused,
        paused_reason: paused ? reason?.trim() || null : null,
        paused_at: paused ? new Date() : null,
        paused_by: paused ? userId : null,
      },
      update: {
        paused,
        paused_reason: paused ? reason?.trim() || null : null,
        paused_at: paused ? new Date() : null,
        paused_by: paused ? userId : null,
      },
    });
    this.logger.warn(
      `Envío de correo ${paused ? 'PAUSADO' : 'reanudado'} por ${userId}`,
    );
    return this.status();
  }

  async list(query: OutboxListQuery) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const where: Prisma.email_outboxWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.template) where.template = query.template;
    if (query.search?.trim()) {
      const term = query.search.trim();
      where.OR = [
        { recipient_email: { contains: term, mode: 'insensitive' } },
        { recipient_name: { contains: term, mode: 'insensitive' } },
        { subject: { contains: term, mode: 'insensitive' } },
      ];
    }
    if (query.desde || query.hasta) {
      where.created_at = {
        ...(query.desde
          ? { gte: cdmxDayStart(new Date(`${query.desde}T12:00:00Z`)) }
          : {}),
        ...(query.hasta
          ? {
              lt: new Date(
                cdmxDayStart(new Date(`${query.hasta}T12:00:00Z`)).getTime() +
                  86_400_000,
              ),
            }
          : {}),
      };
    }
    const [total, rows, templates] = await Promise.all([
      this.prisma.email_outbox.count({ where }),
      this.prisma.email_outbox.findMany({
        where,
        select: LIST_SELECT,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.email_outbox.findMany({
        distinct: ['template'],
        select: { template: true },
        orderBy: { template: 'asc' },
      }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      data: rows,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
      templates: templates.map((t) => t.template),
    };
  }

  async detail(id: string) {
    const row = await this.prisma.email_outbox.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Correo no encontrado');
    return row;
  }

  // ── Internos ────────────────────────────────────────────────────────────

  private async settings() {
    return (
      (await this.prisma.email_settings.findUnique({ where: { id: 1 } })) ?? {
        id: 1,
        paused: false,
        paused_reason: null,
        paused_at: null,
        paused_by: null,
        updated_at: new Date(0),
      }
    );
  }

  /** Enviados o simulados desde el inicio del día (CDMX): cuentan al tope. */
  private sentToday(now: Date): Promise<number> {
    return this.prisma.email_outbox.count({
      where: {
        status: { in: ['enviado', 'simulado'] },
        sent_at: { gte: cdmxDayStart(now) },
      },
    });
  }

  private async lastAttemptAt(): Promise<Date | null> {
    const agg = await this.prisma.email_outbox.aggregate({
      _max: { last_attempt_at: true },
    });
    return agg._max.last_attempt_at ?? null;
  }
}
