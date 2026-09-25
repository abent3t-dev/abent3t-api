import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
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
import {
  applyColumnQuery,
  columnFacet,
  paginateRows,
  parseColumnQuery,
  requireFacetColumn,
} from '../common/column-filters/column-filters';
import { EXPEDITING_FILTER_COLUMNS } from './expediting.columns';
import { maximoBuyerName } from '../common/utils/buyer.util';
import type { BuyerKind } from '../common/utils/buyer.util';

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
 *
 * Bloque 2026-09-23:
 *  - D1: una OC migrada de Maximo a SAP sale UNA vez: se conserva la fila de
 *    SAP (tiene la fecha comprometida) con `maximo_ponum` para el badge y se
 *    omite la de Maximo con ese PONUM.
 *  - D6: `requested_by` de Maximo se traduce con los alias.
 *  - D9: `findAllForExport` (Excel con los mismos filtros, sin paginar).
 *
 * Pedidos de Ingrid 2026-09-25:
 *  - E1: filtro "tipo Excel" por columna (`filters`/`sort`, `/facets`); la
 *    lista, las tarjetas (`stats`) y el Excel salen de la MISMA colección
 *    filtrada.
 *  - E3: "Retraso promedio" = días de retraso promedio de las retrasadas,
 *    con los filtros aplicados y por fuente.
 *  - E4: comprador — ABENT: el de la OC; Maximo: PURCHASEAGENT (alias o
 *    nombre); SAP creada desde Maximo: el de Maximo; SAP propia: quién la
 *    capturó (SAP no tiene comprador en ninguna OC de PRD).
 */

const SAFETY_SCAN_LIMIT = 2000;
/** Tope por fuente ERP al derivar en memoria (B6): OC abiertas SAP ~750 en prod. */
const ERP_SCAN_LIMIT = 5000;

/**
 * Sprint 2026-09-22 (B6): fila de expeditación de una OC del ERP (SAP
 * abierta / Maximo APPR-INPRG). Misma forma que las propias para la tabla;
 * `purchase_order_id` null = sin acciones (solo lectura, badge de origen).
 */
interface ErpRow {
  source: 'sap' | 'maximo';
  external_key: string;
  po_number: string;
  po_status: string | null;
  supplier_name: string | null;
  amount: unknown;
  currency: string | null;
  expected_date: Date | null;
  requested_by: string | null;
  /** SAP: PONUM de Maximo si la OC nació allá (D1). */
  maximo_ponum: string | null;
  /** E4: PURCHASEAGENT de Maximo (de la OC de Maximo o de la que originó la de SAP). */
  buyer_code: string | null;
  buyer_name: string | null;
  /** E4: SAP, usuario que capturó la OC (respaldo del comprador). */
  created_by_name: string | null;
  /** E4: la OC de SAP migrada existe en el staging de Maximo. */
  maximo_exists: boolean;
}

/** Tope del export (D9), mismo criterio que los demás listados. */
const EXPORT_MAX_ROWS = 20_000;

const CURRENT_MAXIMO_POS = Prisma.sql`
  SELECT DISTINCT ON (ponum, coalesce(siteid, '')) *
  FROM maximo_purchase_orders
  ORDER BY ponum, coalesce(siteid, ''), coalesce(revisionnum, 0) DESC`;

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
    private readonly aliases: ErpAliasesService,
  ) {}

  // ── Lectura ─────────────────────────────────────────────────────────────

  async findAll(query: ExpeditingQueryDto) {
    const filtered = await this.collect(query);
    return paginateRows(filtered, query.page ?? 1, query.limit ?? 20);
  }

  /** D9: mismos filtros que el listado, sin paginar (tope). */
  async findAllForExport(query: ExpeditingQueryDto) {
    const rows = await this.collect(query);
    return {
      rows: rows.slice(0, EXPORT_MAX_ROWS),
      truncated: rows.length > EXPORT_MAX_ROWS,
    };
  }

  /**
   * E1: valores de una columna con los DEMÁS filtros aplicados (como el
   * filtro de Excel), con conteo; rango mín/máx en fechas y números.
   */
  async facets(query: ExpeditingQueryDto) {
    const column = requireFacetColumn(query.column, EXPEDITING_FILTER_COLUMNS);
    const rows = await this.collect(query, { exclude: column });
    return columnFacet(
      rows,
      EXPEDITING_FILTER_COLUMNS,
      column,
      query.facet_search,
    );
  }

  /**
   * Lista derivada y filtrada (propias + ERPs), ordenada por fecha vigente
   * (o por la columna pedida en `sort`). `exclude` = columna cuya faceta se
   * arma (su propio filtro no se aplica).
   */
  private async collect(
    query: ExpeditingQueryDto,
    options: { exclude?: string } = {},
  ) {
    const columnQuery = parseColumnQuery(query, EXPEDITING_FILTER_COLUMNS);
    const today = cdmxDateUtc();
    const source = query.source;

    // B6: OC abiertas de los ERPs (solo lectura) entran a la misma lista.
    // Se derivan en memoria como las propias (mismo motor de estatus).
    const erpItems =
      !query.buyer_id && !query.supplier_id && source !== 'abent'
        ? await this.loadErpItems(today, query, source)
        : [];

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

    const ownItems =
      source && source !== 'abent'
        ? []
        : rows.map((row) => this.toListItem(row, today));
    const mapped = [...ownItems, ...erpItems].sort((a, b) => {
      const da = a.effective_expected_date?.getTime() ?? Infinity;
      const db = b.effective_expected_date?.getTime() ?? Infinity;
      if (da !== db) return da - db;
      return a.po_number.localeCompare(b.po_number);
    });
    const byStatus = query.status
      ? mapped.filter((item) => item.delivery_status === query.status)
      : mapped;
    return applyColumnQuery(byStatus, EXPEDITING_FILTER_COLUMNS, columnQuery, {
      exclude: options.exclude,
      sort: options.exclude === undefined,
    });
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

  /**
   * Tarjetas del semáforo con los MISMOS filtros que la lista (E1). E3:
   * "Retraso promedio" = promedio de días de retraso de las retrasadas, en
   * total y por fuente (null = ninguna retrasada, nunca 0).
   */
  async getStats(query: ExpeditingQueryDto = {}) {
    const items = await this.collect(query);

    const counts: Record<DerivedDeliveryStatus, number> = {
      sin_fecha: 0,
      en_tiempo: 0,
      en_riesgo: 0,
      retrasada: 0,
      parcial: 0,
      entregada: 0,
    };
    // B6: las OC abiertas de los ERPs suman al semáforo (por fuente aparte).
    const bySource = {
      abent: { ...counts },
      sap: { ...counts },
      maximo: { ...counts },
    };
    const delay = {
      all: { days: 0, count: 0 },
      abent: { days: 0, count: 0 },
      sap: { days: 0, count: 0 },
      maximo: { days: 0, count: 0 },
    };
    const bySupplier = new Map<string, { name: string; late: number }>();

    for (const item of items) {
      counts[item.delivery_status] += 1;
      bySource[item.source][item.delivery_status] += 1;
      if (item.delivery_status !== 'retrasada') continue;
      if (item.days_left !== null) {
        for (const bucket of [delay.all, delay[item.source]]) {
          bucket.days += -item.days_left;
          bucket.count += 1;
        }
      }
      const name = item.supplier?.legal_name;
      if (name) {
        const key = item.supplier?.id ?? name;
        const entry = bySupplier.get(key) ?? { name, late: 0 };
        entry.late += 1;
        bySupplier.set(key, entry);
      }
    }

    const avg = (bucket: { days: number; count: number }) =>
      bucket.count ? Math.round((bucket.days / bucket.count) * 10) / 10 : null;

    return {
      total: items.length,
      counts,
      by_source: bySource,
      avg_delay_days: avg(delay.all),
      avg_delay_by_source: {
        abent: avg(delay.abent),
        sap: avg(delay.sap),
        maximo: avg(delay.maximo),
      },
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

  /**
   * B6: OC abiertas de SAP (bost_Open no canceladas, fecha = DocDueDate) y
   * de Maximo (APPR/INPRG vigentes, fecha = VENDELIVERYDATE del raw; si no
   * viene → sin_fecha). Agregado en SQL, derivación de semáforo en memoria
   * con el MISMO motor que las propias. Solo lectura.
   */
  private async loadErpItems(
    today: Date,
    query: { search?: string; expected_from?: string; expected_to?: string },
    source: 'abent' | 'sap' | 'maximo' | undefined,
  ) {
    const term = query.search ? `%${query.search}%` : null;
    const from = query.expected_from ? new Date(query.expected_from) : null;
    const to = query.expected_to ? new Date(query.expected_to) : null;
    const [sapRows, maximoRows] = await Promise.all([
      // Aunque se pida solo Maximo, las OC abiertas de SAP se necesitan para
      // no mostrar dos veces las migradas (D1): se descartan después.
      // E4: comprador de las migradas = PURCHASEAGENT de su OC en Maximo.
      this.prisma.$queryRaw<ErpRow[]>(Prisma.sql`
            SELECT 'sap'::text AS source,
                   s.doc_entry::text AS external_key,
                   coalesce(s.doc_num::text, s.doc_entry::text) AS po_number,
                   s.document_status AS po_status,
                   s.card_name AS supplier_name,
                   s.doc_total AS amount,
                   s.currency,
                   s.doc_due_date AS expected_date,
                   NULL::text AS requested_by,
                   s.maximo_ponum,
                   mx.purchase_agent AS buyer_code,
                   mx.purchase_agent_name AS buyer_name,
                   s.created_by_name,
                   (mx.ponum IS NOT NULL) AS maximo_exists
            FROM sap_purchase_orders s
            LEFT JOIN LATERAL (
              SELECT m.ponum, m.purchase_agent, m.purchase_agent_name
              FROM maximo_purchase_orders m
              WHERE s.maximo_ponum IS NOT NULL AND m.ponum = s.maximo_ponum
              ORDER BY coalesce(m.revisionnum, 0) DESC
              LIMIT 1
            ) mx ON true
            WHERE s.document_status = 'bost_Open' AND s.cancelled IS DISTINCT FROM true
              AND (${term}::text IS NULL OR s.card_name ILIKE ${term} OR s.doc_num::text ILIKE ${term})
              AND (${from}::timestamptz IS NULL OR s.doc_due_date >= ${from})
              AND (${to}::timestamptz IS NULL OR s.doc_due_date <= ${to})
            ORDER BY s.doc_due_date ASC NULLS LAST
            LIMIT ${ERP_SCAN_LIMIT}`),
      source === 'sap'
        ? Promise.resolve([] as ErpRow[])
        : this.prisma.$queryRaw<ErpRow[]>(Prisma.sql`
            WITH current AS (${CURRENT_MAXIMO_POS})
            SELECT 'maximo'::text AS source,
                   ponum AS external_key,
                   ponum AS po_number,
                   status AS po_status,
                   vendor_name AS supplier_name,
                   total_cost AS amount,
                   currency,
                   NULLIF(coalesce(raw->'Attributes'->'VENDELIVERYDATE'->>'content',
                                   raw->>'VENDELIVERYDATE'), '')::timestamptz AS expected_date,
                   requested_by,
                   NULL::text AS maximo_ponum,
                   purchase_agent AS buyer_code,
                   purchase_agent_name AS buyer_name,
                   NULL::text AS created_by_name,
                   false AS maximo_exists
            FROM current
            WHERE status IN ('APPR', 'INPRG')
              AND (${term}::text IS NULL OR vendor_name ILIKE ${term} OR ponum ILIKE ${term})
            ORDER BY ponum ASC
            LIMIT ${ERP_SCAN_LIMIT}`),
    ]);
    // D1: PONUM de las OC de SAP que nacieron en Maximo → la fila de Maximo
    // con ese PONUM se omite (queda la de SAP, que trae la fecha comprometida).
    const migrated = new Set(
      sapRows.map((r) => r.maximo_ponum).filter((p): p is string => p !== null),
    );
    // D6/E4: alias de solicitantes y compradores de Maximo
    const aliasNames = await this.aliases.resolveMany('maximo', [
      ...maximoRows.map((r) => r.requested_by),
      ...sapRows.map((r) => r.buyer_code),
      ...maximoRows.map((r) => r.buyer_code),
    ]);
    const buyerOf = (row: ErpRow): { name: string | null; kind: BuyerKind } => {
      if (row.buyer_code) {
        return {
          name: maximoBuyerName(row.buyer_code, row.buyer_name, aliasNames),
          kind: 'comprador',
        };
      }
      // La migrada la capturó el usuario de la integración: no es comprador
      if (row.source === 'sap' && row.created_by_name && !row.maximo_exists) {
        return { name: row.created_by_name, kind: 'capturo' };
      }
      return { name: null, kind: null };
    };
    return [...(source === 'maximo' ? [] : sapRows), ...maximoRows]
      .filter((row) => {
        if (row.source !== 'maximo') return true;
        if (migrated.has(row.po_number)) return false;
        const d = row.expected_date;
        if (from && (!d || d < from)) return false;
        if (to && (!d || d > to)) return false;
        return true;
      })
      .map((row) => {
        const expected = row.expected_date ? new Date(row.expected_date) : null;
        const status = deriveDeliveryStatus(
          {
            expected_date: expected,
            actual_delivery_date: null,
            po_status: null,
            tracking_status: null,
          },
          today,
        );
        const buyer = buyerOf(row);
        return {
          purchase_order_id: null as string | null,
          source: row.source,
          external_key: row.external_key,
          po_number: row.po_number,
          po_status: row.po_status,
          supplier: row.supplier_name
            ? {
                id: null as string | null,
                legal_name: row.supplier_name,
                email: null as string | null,
              }
            : null,
          buyer: null,
          buyer_name: buyer.name,
          buyer_kind: buyer.kind,
          requisition: null,
          amount: toNumber(row.amount),
          currency: row.currency,
          expected_delivery_date: expected,
          effective_expected_date: expected,
          actual_delivery_date: null,
          delivery_status: status,
          days_left: expected ? daysUntilDate(expected, today) : null,
          tracking: null,
          requested_by:
            row.requested_by === null
              ? null
              : (aliasNames.get(row.requested_by) ?? row.requested_by),
          maximo_ponum: row.maximo_ponum,
        };
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
      purchase_order_id: row.id as string | null,
      source: 'abent' as const,
      external_key: row.id,
      po_number: row.po_number,
      po_status: row.status as string | null,
      supplier: row.suppliers as {
        id: string | null;
        legal_name: string;
        email: string | null;
      } | null,
      currency: 'MXN' as string | null,
      requested_by: null as string | null,
      maximo_ponum: null as string | null,
      buyer: row.profiles,
      buyer_name: row.profiles?.full_name ?? null,
      buyer_kind: (row.profiles?.full_name ? 'comprador' : null) as BuyerKind,
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
