import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { cdmxDateUtc } from '../contracts/contracts.dates';
import {
  CRITICAL_AFTER_DAYS,
  DerivedDeliveryStatus,
  daysUntilDate,
  deriveDeliveryStatus,
  RISK_WINDOW_DAYS,
} from './expediting.status';
import { ExpeditingQueryDto } from './dto/expediting-query.dto';
import {
  FollowUpDto,
  ReceiptDto,
  RescheduleDto,
} from './dto/expediting-actions.dto';

/**
 * Fase Expeditación — Seguimiento de entregas de purchase_orders PROPIAS
 * (regla 1: el staging de integraciones no se expedita desde ABENT).
 *
 * Regla 2, opción (b): la recepción TOTAL actualiza `actual_delivery_date`
 * y el estatus de la PO; `on_time_delivery_rate` de suppliers.service queda
 * intacto y se alimenta solo (mide contra la fecha esperada ORIGINAL de la
 * PO — una reprogramación del tracking solo gobierna alertas/estatus, T9).
 *
 * El tracking se crea de forma PEREZOSA (primer evento o primera alerta),
 * mismo efecto que crearlo con la PEO sin tocar purchase-orders.
 */

const SAFETY_SCAN_LIMIT = 2000;

const PO_INCLUDE = {
  suppliers: { select: { id: true, legal_name: true, email: true } },
  profiles: { select: { id: true, full_name: true, email: true } }, // comprador
  requisitions: { select: { id: true, rq_number: true } },
  delivery_tracking: true,
} as const;

type PoRow = Prisma.purchase_ordersGetPayload<{ include: typeof PO_INCLUDE }>;

const EVENT_SELECT = {
  id: true,
  event_type: true,
  comment: true,
  previous_expected_date: true,
  new_expected_date: true,
  received_date: true,
  quantity: true,
  created_by: true,
  created_at: true,
  profiles: { select: { full_name: true } },
} as const;

function toNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

@Injectable()
export class ExpeditingService {
  private readonly logger = new Logger(ExpeditingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  // ── Lectura ─────────────────────────────────────────────────────────────

  async findAll(query: ExpeditingQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const today = cdmxDateUtc();

    const where: Prisma.purchase_ordersWhereInput = {
      is_active: true,
      status: { not: 'cancelada' },
    };
    if (query.buyer_id) where.buyer_id = query.buyer_id;
    if (query.supplier_id) where.supplier_id = query.supplier_id;
    if (query.expected_from || query.expected_to) {
      where.expected_delivery_date = {
        ...(query.expected_from ? { gte: new Date(query.expected_from) } : {}),
        ...(query.expected_to ? { lte: new Date(query.expected_to) } : {}),
      };
    }
    if (query.search) {
      where.OR = [
        { po_number: { contains: query.search, mode: 'insensitive' } },
        {
          suppliers: {
            legal_name: { contains: query.search, mode: 'insensitive' },
          },
        },
      ];
    }

    // El estatus se DERIVA, así que el filtro por estatus se aplica después
    // de derivar (el volumen de POs activas lo permite; tope de seguridad).
    const rows = await this.prisma.purchase_orders.findMany({
      where,
      include: PO_INCLUDE,
      orderBy: [{ expected_delivery_date: 'asc' }, { po_number: 'asc' }],
      take: SAFETY_SCAN_LIMIT,
    });

    const mapped = rows.map((row) => this.toListItem(row, today));
    const filtered = query.status
      ? mapped.filter((item) => item.delivery_status === query.status)
      : mapped;

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      data: filtered.slice((page - 1) * limit, page * limit),
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  async findOne(purchaseOrderId: string) {
    const po = await this.prisma.purchase_orders.findFirst({
      where: { id: purchaseOrderId, is_active: true },
      include: PO_INCLUDE,
    });
    if (!po) throw new NotFoundException('Orden de compra no encontrada');

    const tracking = po.delivery_tracking;
    const [events, alerts] = tracking
      ? await Promise.all([
          this.prisma.delivery_tracking_events.findMany({
            where: { delivery_tracking_id: tracking.id },
            select: EVENT_SELECT,
            orderBy: { created_at: 'asc' },
          }),
          this.prisma.expediting_alerts.findMany({
            where: { delivery_tracking_id: tracking.id },
            orderBy: { sent_at: 'desc' },
            select: {
              id: true,
              alert_type: true,
              alert_date: true,
              sent_to: true,
              sent_at: true,
            },
          }),
        ])
      : [[], []];

    const today = cdmxDateUtc();
    return {
      ...this.toListItem(po, today),
      events: events.map((event) => ({
        ...event,
        quantity: toNumber(event.quantity),
        created_by_name: event.profiles?.full_name ?? null,
        profiles: undefined,
      })),
      alerts,
    };
  }

  async getStats() {
    const today = cdmxDateUtc();
    const rows = await this.prisma.purchase_orders.findMany({
      where: { is_active: true, status: { not: 'cancelada' } },
      include: PO_INCLUDE,
      take: SAFETY_SCAN_LIMIT,
    });

    const counts: Record<DerivedDeliveryStatus, number> = {
      sin_fecha: 0,
      en_tiempo: 0,
      en_riesgo: 0,
      retrasada: 0,
      parcial: 0,
      entregada: 0,
    };
    let lateDeliveredDays = 0;
    let lateDeliveredCount = 0;
    const bySupplier = new Map<string, { name: string; late: number }>();

    for (const row of rows) {
      const status = this.deriveFor(row, today);
      counts[status] += 1;

      const expectedOriginal = row.expected_delivery_date;
      const isLateDelivered =
        status === 'entregada' &&
        row.actual_delivery_date !== null &&
        expectedOriginal !== null &&
        row.actual_delivery_date.getTime() > expectedOriginal.getTime();
      if (isLateDelivered && row.actual_delivery_date && expectedOriginal) {
        lateDeliveredDays += daysUntilDate(
          row.actual_delivery_date,
          expectedOriginal,
        );
        lateDeliveredCount += 1;
      }
      if (status === 'retrasada' || isLateDelivered) {
        const entry = bySupplier.get(row.supplier_id) ?? {
          name: row.suppliers.legal_name,
          late: 0,
        };
        entry.late += 1;
        bySupplier.set(row.supplier_id, entry);
      }
    }

    return {
      counts,
      avg_delay_days: lateDeliveredCount
        ? Math.round((lateDeliveredDays / lateDeliveredCount) * 10) / 10
        : null,
      top_delayed_suppliers: [...bySupplier.entries()]
        .map(([supplier_id, s]) => ({
          supplier_id,
          legal_name: s.name,
          late_orders: s.late,
        }))
        .sort((a, b) => b.late_orders - a.late_orders)
        .slice(0, 5),
    };
  }

  // ── Mutaciones (PURCHASE_TEAM; escritor único del tracking) ─────────────

  async registerFollowUp(poId: string, dto: FollowUpDto, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const po = await this.loadPo(tx, poId);
      const tracking = await this.ensureTracking(tx, po);
      await tx.delivery_tracking_events.create({
        data: {
          delivery_tracking_id: tracking.id,
          event_type: 'seguimiento',
          comment: dto.note,
          created_by: userId,
        },
      });
      return { message: 'Seguimiento registrado' };
    });
  }

  async reschedule(poId: string, dto: RescheduleDto, userId: string) {
    const newDate = new Date(dto.new_expected_date);
    return this.prisma.$transaction(async (tx) => {
      const po = await this.loadPo(tx, poId);
      if (po.status === 'entregada_completa') {
        throw new BadRequestException('La orden ya fue entregada');
      }
      const tracking = await this.ensureTracking(tx, po, newDate);
      await tx.delivery_tracking_events.create({
        data: {
          delivery_tracking_id: tracking.id,
          event_type: 'reprogramacion',
          comment: dto.reason,
          previous_expected_date: tracking.expected_date,
          new_expected_date: newDate,
          created_by: userId,
        },
      });
      // Solo el tracking cambia: la fecha ORIGINAL de la PO sigue midiendo
      // la puntualidad del proveedor (T9)
      await tx.delivery_tracking.update({
        where: { id: tracking.id },
        data: { expected_date: newDate },
      });
      return { message: 'Fecha esperada reprogramada' };
    });
  }

  async registerReceipt(poId: string, dto: ReceiptDto, userId: string) {
    const receivedDate = new Date(dto.received_date);
    return this.prisma.$transaction(async (tx) => {
      const po = await this.loadPo(tx, poId);
      if (po.status === 'entregada_completa') {
        throw new BadRequestException('La orden ya fue entregada por completo');
      }
      const tracking = await this.ensureTracking(tx, po, receivedDate);
      await tx.delivery_tracking_events.create({
        data: {
          delivery_tracking_id: tracking.id,
          event_type:
            dto.type === 'total' ? 'recepcion_total' : 'recepcion_parcial',
          comment: dto.comment,
          received_date: receivedDate,
          quantity: dto.quantity,
          created_by: userId,
        },
      });

      if (dto.type === 'total') {
        await tx.delivery_tracking.update({
          where: { id: tracking.id },
          data: {
            current_status: 'entregada',
            delivery_confirmed_at: new Date(),
            confirmed_by: userId,
          },
        });
        // Regla 2(b): la recepción total alimenta el cálculo existente de
        // on_time_delivery_rate vía actual_delivery_date + estatus de la PO
        await tx.purchase_orders.update({
          where: { id: po.id },
          data: {
            actual_delivery_date: receivedDate,
            status: 'entregada_completa',
          },
        });
        this.logger.log(`PO ${po.po_number} recibida por completo`);
        return { message: 'Recepción total registrada; la PO quedó entregada' };
      }

      await tx.delivery_tracking.update({
        where: { id: tracking.id },
        data: { current_status: 'entregada_parcial' },
      });
      await tx.purchase_orders.update({
        where: { id: po.id },
        data: { status: 'entregada_parcial' },
      });
      return { message: 'Recepción parcial registrada' };
    });
  }

  // ── Job de alertas (T9: -15 una vez / vencida una vez / +7 diaria) ──────

  async runAlertCheck(now: Date = new Date()) {
    const result = {
      checked: 0,
      sent: 0,
      alreadySent: 0,
      errors: [] as string[],
    };
    const today = cdmxDateUtc(now);
    const rows = await this.prisma.purchase_orders.findMany({
      where: {
        is_active: true,
        status: { notIn: ['cancelada', 'entregada_completa'] },
      },
      include: PO_INCLUDE,
      take: SAFETY_SCAN_LIMIT,
    });
    result.checked = rows.length;

    for (const po of rows) {
      try {
        if (po.delivery_tracking?.current_status === 'entregada') continue;
        const expected =
          po.delivery_tracking?.expected_date ?? po.expected_delivery_date;
        if (!expected) continue;
        const daysLeft = daysUntilDate(expected, today);

        let alertType: 'preventiva' | 'recordatorio' | 'critica' | null = null;
        let alertDate = expected;
        if (daysLeft >= 0 && daysLeft <= RISK_WINDOW_DAYS) {
          alertType = 'preventiva'; // una vez por fecha esperada
        } else if (daysLeft < 0 && -daysLeft < CRITICAL_AFTER_DAYS) {
          alertType = 'recordatorio'; // una vez por vencimiento
        } else if (daysLeft < 0) {
          alertType = 'critica'; // diaria desde +7
          alertDate = today;
        }
        if (!alertType) continue;

        const sent = await this.sendAlert(po, alertType, alertDate, daysLeft);
        if (sent === 'sent') result.sent += 1;
        else result.alreadySent += 1;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${po.po_number}: ${msg}`);
      }
    }

    if (result.sent > 0 || result.errors.length > 0) {
      this.logger.log(
        `Alertas de expeditación: revisadas=${result.checked} enviadas=${result.sent} ` +
          `repetidas=${result.alreadySent} errores=${result.errors.length}`,
      );
    }
    return result;
  }

  private async sendAlert(
    po: PoRow,
    alertType: 'preventiva' | 'recordatorio' | 'critica',
    alertDate: Date,
    daysLeft: number,
  ): Promise<'sent' | 'duplicate'> {
    // Destinatarios (§Alertas): comprador + proveedor; crítica += supervisores
    const recipients: Array<{ email: string; name: string | null }> = [];
    if (po.profiles?.email) {
      recipients.push({
        email: po.profiles.email,
        name: po.profiles.full_name,
      });
    }
    if (po.suppliers.email) {
      recipients.push({
        email: po.suppliers.email,
        name: po.suppliers.legal_name,
      });
    }
    if (alertType === 'critica') {
      const supervisors = await this.prisma.profiles.findMany({
        where: {
          is_active: true,
          OR: [
            {
              user_roles_user_roles_profile_idToprofiles: {
                some: { is_active: true, role: 'lider_procura' },
              },
            },
            { role: 'lider_procura' },
          ],
        },
        select: { email: true, full_name: true },
      });
      for (const s of supervisors) {
        recipients.push({ email: s.email, name: s.full_name });
      }
    }
    if (recipients.length === 0) return 'sent'; // nada que enviar, no bloquear

    try {
      await this.prisma.$transaction(async (tx) => {
        const tracking = await this.ensureTracking(tx, po);
        await tx.expediting_alerts.create({
          data: {
            delivery_tracking_id: tracking.id,
            alert_type: alertType,
            alert_date: alertDate,
            sent_to: [...new Set(recipients.map((r) => r.email))],
          },
        });
        await tx.delivery_tracking.update({
          where: { id: tracking.id },
          data: { last_alert_sent: new Date(), alert_count: { increment: 1 } },
        });
        const subject =
          alertType === 'preventiva'
            ? `[ABENT 3T] Entrega próxima: PO ${po.po_number} (${daysLeft} días)`
            : alertType === 'recordatorio'
              ? `[ABENT 3T] Entrega vencida: PO ${po.po_number}`
              : `[ABENT 3T] RETRASO CRÍTICO: PO ${po.po_number} (${-daysLeft} días vencida)`;
        for (const recipient of recipients) {
          const sent = await this.emailService.sendEmail({
            to: { email: recipient.email, name: recipient.name ?? undefined },
            subject,
            body: this.alertBody(po, alertType, daysLeft, recipient.name),
            isHtml: true,
          });
          if (!sent.success) {
            throw new Error(sent.error ?? 'envío de correo fallido');
          }
        }
      });
      return 'sent';
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'P2002') return 'duplicate';
      throw err;
    }
  }

  private alertBody(
    po: PoRow,
    alertType: string,
    daysLeft: number,
    recipientName: string | null,
  ): string {
    const frontend =
      process.env.FRONTEND_URL?.split(',')[0] ?? 'http://localhost:3000';
    const situation =
      alertType === 'preventiva'
        ? `vence en ${daysLeft} días`
        : alertType === 'recordatorio'
          ? 'está vencida sin registro de entrega'
          : `lleva ${-daysLeft} días de retraso`;
    return [
      `<p>Estimado/a <strong>${recipientName ?? ''}</strong>,</p>`,
      `<p>La orden de compra <strong>${po.po_number}</strong> (proveedor ${po.suppliers.legal_name}) ${situation}.</p>`,
      `<p>Requisición: ${po.requisitions?.rq_number ?? '—'} · Comprador: ${po.profiles?.full_name ?? '—'}</p>`,
      `<p><a href="${frontend}/compras/expeditacion">Abrir Expeditación</a></p>`,
      '<p style="color:#666;font-size:12px">Mensaje automático del sistema de compras ABENT 3T.</p>',
    ].join('\n');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async loadPo(tx: Prisma.TransactionClient, id: string) {
    const po = await tx.purchase_orders.findFirst({
      where: { id, is_active: true },
      include: PO_INCLUDE,
    });
    if (!po) throw new NotFoundException('Orden de compra no encontrada');
    if (po.status === 'cancelada') {
      throw new BadRequestException('La orden está cancelada');
    }
    return po;
  }

  /** Creación perezosa del tracking (1:1 con la PO). */
  private async ensureTracking(
    tx: Prisma.TransactionClient,
    po: { id: string; expected_delivery_date: Date | null },
    fallbackDate?: Date,
  ) {
    const existing = await tx.delivery_tracking.findFirst({
      where: { purchase_order_id: po.id },
    });
    if (existing) return existing;
    const expected = po.expected_delivery_date ?? fallbackDate;
    if (!expected) {
      throw new BadRequestException(
        'La orden no tiene fecha esperada de entrega: captúrala reprogramando',
      );
    }
    return tx.delivery_tracking.create({
      data: { purchase_order_id: po.id, expected_date: expected },
    });
  }

  private deriveFor(row: PoRow, today: Date): DerivedDeliveryStatus {
    return deriveDeliveryStatus(
      {
        expected_date:
          row.delivery_tracking?.expected_date ?? row.expected_delivery_date,
        actual_delivery_date: row.actual_delivery_date,
        po_status: row.status,
        tracking_status: row.delivery_tracking?.current_status ?? null,
      },
      today,
    );
  }

  private toListItem(row: PoRow, today: Date) {
    const effectiveExpected =
      row.delivery_tracking?.expected_date ?? row.expected_delivery_date;
    const status = this.deriveFor(row, today);
    return {
      purchase_order_id: row.id,
      po_number: row.po_number,
      po_status: row.status,
      supplier: row.suppliers,
      buyer: row.profiles,
      requisition: row.requisitions,
      amount: toNumber(row.amount),
      expected_delivery_date: row.expected_delivery_date,
      effective_expected_date: effectiveExpected,
      actual_delivery_date: row.actual_delivery_date,
      delivery_status: status,
      days_left: effectiveExpected
        ? daysUntilDate(effectiveExpected, today)
        : null,
      tracking: row.delivery_tracking
        ? {
            id: row.delivery_tracking.id,
            current_status: row.delivery_tracking.current_status,
            alert_count: row.delivery_tracking.alert_count,
            last_alert_sent: row.delivery_tracking.last_alert_sent,
            notes: row.delivery_tracking.notes,
          }
        : null,
    };
  }
}
