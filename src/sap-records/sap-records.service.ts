import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaginatedResponse } from '../common/interfaces/paginated-response.interface';
import { deriveSapLines } from './sap-document-raw';
import { SapDocQueryDto } from './dto/sap-doc-query.dto';
import {
  SapEntitySummary,
  SapLastSyncRun,
  SapPurchaseOrderDetail,
  SapPurchaseOrderRow,
  SapPurchaseRequestDetail,
  SapPurchaseRequestRow,
  SapStatusCount,
  SapSummary,
} from './sap-records.types';

/**
 * Fase INT-4 — Lectura de dominio sobre el staging de SAP. SOLO lee
 * `sap_purchase_orders` / `sap_purchase_requests` / `sap_sync_runs`; el
 * único escritor sigue siendo el sync. Sin dependencia de la capa externa
 * (criterio de aceptación por grep, igual que el módulo de lectura del
 * otro ERP en Int-5).
 *
 * A diferencia de ese staging aquí NO hay revisiones: una fila por documento,
 * así que todo va por el query builder de Prisma (sin SQL crudo).
 */

const DEFAULT_LIMIT = 20;

/** Alias legibles del filtro `status` → valores bost_* del ERP. */
const STATUS_ALIASES: Record<string, string> = {
  open: 'bost_Open',
  close: 'bost_Close',
};

const PO_LIST_SELECT = {
  id: true,
  doc_entry: true,
  doc_num: true,
  doc_date: true,
  doc_due_date: true,
  update_date_source: true,
  document_status: true,
  comments: true,
  card_code: true,
  card_name: true,
  doc_total: true,
  currency: true,
  lines_total: true,
  lines_classified: true,
  ahorro_total: true,
  last_changed_at: true,
  last_seen_at: true,
} as const;

const PR_LIST_SELECT = {
  id: true,
  doc_entry: true,
  doc_num: true,
  doc_date: true,
  doc_due_date: true,
  required_date: true,
  update_date_source: true,
  document_status: true,
  comments: true,
  requester: true,
  requester_name: true,
  doc_total: true,
  currency: true,
  lines_total: true,
  lines_classified: true,
  ahorro_total: true,
  last_changed_at: true,
  last_seen_at: true,
} as const;

function toNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function buildMeta(total: number, page: number, limit: number) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

@Injectable()
export class SapRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ── Órdenes de compra ────────────────────────────────────────────────────

  async listPurchaseOrders(
    query: SapDocQueryDto,
  ): Promise<PaginatedResponse<SapPurchaseOrderRow>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const where = this.buildWhere(query, ['card_name', 'card_code']);

    const [total, rows] = await Promise.all([
      this.prisma.sap_purchase_orders.count({ where }),
      this.prisma.sap_purchase_orders.findMany({
        where,
        select: PO_LIST_SELECT,
        orderBy: [
          { doc_date: { sort: 'desc', nulls: 'last' } },
          { doc_entry: 'desc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      data: rows.map((row) => this.toPoRow(row)),
      meta: buildMeta(total, page, limit),
    };
  }

  async getPurchaseOrder(
    docEntry: number,
    includeRaw: boolean,
  ): Promise<SapPurchaseOrderDetail> {
    // Select explícito + separar `raw` ANTES de mapear: un spread del row
    // completo colaría raw/raw_hash dentro de `document` para TODOS los
    // viewers (omitir el raw ES el control de acceso).
    const row = await this.prisma.sap_purchase_orders.findFirst({
      where: { doc_entry: docEntry },
      select: { ...PO_LIST_SELECT, raw: true },
    });
    if (!row) {
      throw new NotFoundException(
        `Orden de compra SAP con DocEntry ${docEntry} no encontrada`,
      );
    }
    const { raw, ...docFields } = row;
    const detail: SapPurchaseOrderDetail = {
      document: this.toPoRow(docFields),
      lines: deriveSapLines(raw),
    };
    if (includeRaw) detail.raw = raw;
    return detail;
  }

  // ── Solicitudes de pedido ────────────────────────────────────────────────

  async listPurchaseRequests(
    query: SapDocQueryDto,
  ): Promise<PaginatedResponse<SapPurchaseRequestRow>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const where = this.buildWhere(query, ['requester_name', 'requester']);

    const [total, rows] = await Promise.all([
      this.prisma.sap_purchase_requests.count({ where }),
      this.prisma.sap_purchase_requests.findMany({
        where,
        select: PR_LIST_SELECT,
        orderBy: [
          { doc_date: { sort: 'desc', nulls: 'last' } },
          { doc_entry: 'desc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      data: rows.map((row) => this.toPrRow(row)),
      meta: buildMeta(total, page, limit),
    };
  }

  async getPurchaseRequest(
    docEntry: number,
    includeRaw: boolean,
  ): Promise<SapPurchaseRequestDetail> {
    // Ver nota de getPurchaseOrder: select explícito, nunca spread del row.
    const row = await this.prisma.sap_purchase_requests.findFirst({
      where: { doc_entry: docEntry },
      select: { ...PR_LIST_SELECT, raw: true },
    });
    if (!row) {
      throw new NotFoundException(
        `Solicitud de pedido SAP con DocEntry ${docEntry} no encontrada`,
      );
    }
    const { raw, ...docFields } = row;
    const detail: SapPurchaseRequestDetail = {
      document: this.toPrRow(docFields),
      lines: deriveSapLines(raw),
    };
    if (includeRaw) detail.raw = raw;
    return detail;
  }

  // ── Resumen (dashboard) ──────────────────────────────────────────────────

  async getSummary(): Promise<SapSummary> {
    const [po, pr, lastPoRun, lastPrRun] = await Promise.all([
      this.entitySummary('purchase_orders'),
      this.entitySummary('purchase_requests'),
      this.lastRun('purchase_orders'),
      this.lastRun('purchase_requests'),
    ]);
    return {
      syncEnabled: this.isSyncEnabled(),
      purchaseOrders: po,
      purchaseRequests: pr,
      lastSync: { purchase_orders: lastPoRun, purchase_requests: lastPrRun },
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Joi ya convirtió SAP_SYNC_ENABLED a boolean en el env validado; en tests
   * o sin validación puede llegar como string. Se aceptan ambas formas.
   */
  private isSyncEnabled(): boolean {
    const value = this.config.get<boolean | string>('SAP_SYNC_ENABLED');
    return (
      value === true || (typeof value === 'string' && value.trim() === 'true')
    );
  }

  private buildWhere(
    query: SapDocQueryDto,
    searchFields: string[],
  ): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (query.status) {
      where.document_status = STATUS_ALIASES[query.status];
    }
    if (query.from || query.to) {
      where.doc_date = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    const search = query.search?.trim();
    if (search) {
      const or: Record<string, unknown>[] = searchFields.map((field) => ({
        [field]: { contains: search, mode: 'insensitive' },
      }));
      // Solo si cabe en un entero de 32 bits (columnas Int de Postgres):
      // un número más largo haría reventar la consulta con 500.
      if (/^\d+$/.test(search) && Number(search) <= 2_147_483_647) {
        or.push({ doc_num: Number(search) });
        or.push({ doc_entry: Number(search) });
      }
      where.OR = or;
    }
    return where;
  }

  private async entitySummary(
    entity: 'purchase_orders' | 'purchase_requests',
  ): Promise<SapEntitySummary> {
    if (entity === 'purchase_orders') {
      const [byStatus, agg, conAhorro] = await Promise.all([
        this.prisma.sap_purchase_orders.groupBy({
          by: ['document_status'],
          _count: { _all: true },
        }),
        this.prisma.sap_purchase_orders.aggregate({
          _count: { _all: true },
          _sum: { doc_total: true, lines_total: true, lines_classified: true },
        }),
        this.prisma.sap_purchase_orders.count({
          where: { ahorro_total: { not: null } },
        }),
      ]);
      return this.foldSummary(byStatus, agg, conAhorro);
    }
    const [byStatus, agg, conAhorro] = await Promise.all([
      this.prisma.sap_purchase_requests.groupBy({
        by: ['document_status'],
        _count: { _all: true },
      }),
      this.prisma.sap_purchase_requests.aggregate({
        _count: { _all: true },
        _sum: { doc_total: true, lines_total: true, lines_classified: true },
      }),
      this.prisma.sap_purchase_requests.count({
        where: { ahorro_total: { not: null } },
      }),
    ]);
    return this.foldSummary(byStatus, agg, conAhorro);
  }

  private foldSummary(
    byStatus: Array<{
      document_status: string | null;
      _count: { _all: number };
    }>,
    agg: {
      _count: { _all: number };
      _sum: {
        doc_total: Prisma.Decimal | null;
        lines_total: number | null;
        lines_classified: number | null;
      };
    },
    docsConAhorro: number,
  ): SapEntitySummary {
    const statusCounts: SapStatusCount[] = byStatus
      .map((row) => ({ status: row.document_status, count: row._count._all }))
      .sort((a, b) => b.count - a.count);
    return {
      total: agg._count._all,
      byStatus: statusCounts,
      montoTotal: toNumber(agg._sum.doc_total) ?? 0,
      linesTotal: agg._sum.lines_total ?? 0,
      linesClassified: agg._sum.lines_classified ?? 0,
      docsConAhorro,
    };
  }

  private async lastRun(
    target: 'purchase_orders' | 'purchase_requests',
  ): Promise<SapLastSyncRun | null> {
    const run = await this.prisma.sap_sync_runs.findFirst({
      where: { target },
      orderBy: { started_at: 'desc' },
      select: {
        status: true,
        triggered_by: true,
        mode: true,
        started_at: true,
        finished_at: true,
        records_inserted: true,
        records_updated: true,
        records_unchanged: true,
        records_failed: true,
      },
    });
    return run;
  }

  private toPoRow(row: {
    doc_total: unknown;
    ahorro_total: unknown;
    [key: string]: unknown;
  }): SapPurchaseOrderRow {
    return {
      ...(row as unknown as SapPurchaseOrderRow),
      doc_total: toNumber(row.doc_total),
      ahorro_total: toNumber(row.ahorro_total),
    };
  }

  private toPrRow(row: {
    doc_total: unknown;
    ahorro_total: unknown;
    [key: string]: unknown;
  }): SapPurchaseRequestRow {
    return {
      ...(row as unknown as SapPurchaseRequestRow),
      doc_total: toNumber(row.doc_total),
      ahorro_total: toNumber(row.ahorro_total),
    };
  }
}
