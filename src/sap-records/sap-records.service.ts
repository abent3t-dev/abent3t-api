import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaginatedResponse } from '../common/interfaces/paginated-response.interface';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { andYear } from '../common/sql/erp-views.sql';
import { deriveSapLines } from './sap-document-raw';
import {
  applyColumnQuery,
  facetOf,
  isColumnQueryActive,
  paginateRows,
  parseColumnQuery,
} from '../common/column-filters/column-filters';
import { maximoBuyerName } from '../common/utils/buyer.util';
import type { BuyerKind } from '../common/utils/buyer.util';
import {
  SAP_PO_FILTER_COLUMNS,
  SAP_PR_FILTER_COLUMNS,
} from './sap-records.columns';
import { SapApprovalQueryDto } from './dto/sap-approval-query.dto';
import { SapDocQueryDto, SapDocStatusKey } from './dto/sap-doc-query.dto';
import {
  SapApprovalLineView,
  SapApprovalRequestRow,
  SapCurrencyAmount,
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
 * `sap_purchase_orders` / `sap_purchase_requests` / `sap_approval_requests`
 * / `sap_sync_runs`; el único escritor sigue siendo el sync. Sin dependencia
 * de la capa externa (criterio de aceptación por grep, igual que el módulo
 * de lectura del otro ERP en Int-5).
 *
 * A diferencia de ese staging aquí NO hay revisiones: una fila por documento,
 * así que todo va por el query builder de Prisma (sin SQL crudo), salvo los
 * agregados por moneda/estatus del resumen.
 *
 * Sprint 2026-09-22:
 *  - A6: estatus DERIVADO (`status_key`): cancelled → 'cancelled'; si no,
 *    bost_Open → 'open' / bost_Close → 'close'. SAP reporta una cancelada
 *    como bost_Close, por eso `Cancelled` manda.
 *  - A5: `status` acepta varios alias (multi-selección).
 *  - A1: resumen con montos POR MONEDA y días promedio de gestión.
 *  - B1: `listAllForExport` sin paginar (tope) para el Excel.
 *  - B5: cola de autorización (`listApprovalRequests`).
 *
 * Bloque 2026-09-23:
 *  - D1: `origin` (sap | maximo) sobre `maximo_ponum`; `maximo_po_exists`
 *    en cada OC (existe en el staging de Maximo → se cuenta una vez en los
 *    totales combinados). El resumen (/sap/summary) sigue con el total
 *    PROPIO de SAP (tarjeta por sistema) y expone `migradas`.
 *  - D4: `year` en listados y resumen.
 *  - D6: `maximo_requested_by` se traduce con los alias de Maximo.
 *
 * Pedidos de Ingrid 2026-09-25:
 *  - E1: filtro "tipo Excel" por columna. Sin filtros por columna ni orden
 *    el listado sigue paginado en SQL; con ellos se evalúa sobre la vista
 *    completa (mismo loader que el export) con `common/column-filters`.
 *  - E4: comprador de la OC — SAP no lo trae en ninguna OC de PRD
 *    (SalesPersonCode = -1): la migrada de Maximo toma el PURCHASEAGENT de
 *    su OC allá; las demás, quién la capturó ("Capturó: …").
 */

const DEFAULT_LIMIT = 20;
/** Tope del export (B1): evita un XLSX gigante por error. */
export const EXPORT_MAX_ROWS = 20_000;

const PO_LIST_SELECT = {
  id: true,
  doc_entry: true,
  doc_num: true,
  doc_date: true,
  doc_due_date: true,
  update_date_source: true,
  document_status: true,
  cancelled: true,
  authorization_status: true,
  closing_date: true,
  comments: true,
  card_code: true,
  card_name: true,
  doc_total: true,
  currency: true,
  lines_total: true,
  lines_classified: true,
  ahorro_total: true,
  open_total: true,
  user_sign: true,
  created_by_name: true,
  maximo_ponum: true,
  base_request_entries: true,
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
  cancelled: true,
  authorization_status: true,
  closing_date: true,
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

const APPROVAL_LIST_SELECT = {
  id: true,
  code: true,
  approval_template_id: true,
  template_name: true,
  object_type: true,
  is_draft: true,
  draft_entry: true,
  object_entry: true,
  status: true,
  remarks: true,
  current_stage: true,
  current_stage_name: true,
  originator_id: true,
  originator_name: true,
  creation_date: true,
  doc_num: true,
  doc_date: true,
  doc_total: true,
  currency: true,
  card_name: true,
  requester_name: true,
  approvers: true,
  last_changed_at: true,
  last_seen_at: true,
} as const;

/** ObjectType de SAP B1: 22 = OC, 1470000113 = solicitud de pedido. */
const OBJECT_TYPE_KIND: Record<string, 'purchase_order' | 'purchase_request'> =
  { '22': 'purchase_order', '1470000113': 'purchase_request' };

const MS_PER_DAY = 86_400_000;

/** Orden de los listados: más recientes primero. */
const DOC_ORDER = [
  { doc_date: { sort: 'desc' as const, nulls: 'last' as const } },
  { doc_entry: 'desc' as const },
];

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

/** Estatus derivado (A6). null si `cancelled` no se ha sincronizado aún. */
export function deriveStatusKey(row: {
  document_status: string | null;
  cancelled: boolean | null;
}): SapDocStatusKey | null {
  if (row.cancelled === true) return 'cancelled';
  if (row.cancelled === null) {
    // Fila previa a 0011: sin `Cancelled` no se puede afirmar que NO esté
    // cancelada; se reporta el DocumentStatus crudo solo si es inequívoco.
    if (row.document_status === 'bost_Open') return 'open';
    return null;
  }
  if (row.document_status === 'bost_Open') return 'open';
  if (row.document_status === 'bost_Close') return 'close';
  return null;
}

/** Condición Prisma de un alias de estatus derivado. */
function statusCondition(key: SapDocStatusKey): Record<string, unknown> {
  if (key === 'cancelled') return { cancelled: true };
  return {
    document_status: key === 'open' ? 'bost_Open' : 'bost_Close',
    NOT: { cancelled: true },
  };
}

@Injectable()
export class SapRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly aliases: ErpAliasesService,
  ) {}

  // ── Órdenes de compra ────────────────────────────────────────────────────

  async listPurchaseOrders(
    query: SapDocQueryDto,
  ): Promise<PaginatedResponse<SapPurchaseOrderRow>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;
    // E1: filtros por columna u orden → sobre la vista completa
    const columnQuery = parseColumnQuery(query, SAP_PO_FILTER_COLUMNS);
    if (isColumnQueryActive(columnQuery)) {
      const { rows } = await this.loadPurchaseOrders(query);
      return paginateRows(
        applyColumnQuery(rows, SAP_PO_FILTER_COLUMNS, columnQuery),
        page,
        limit,
      );
    }
    const where = await this.poWhere(query);

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
      data: (await this.withRequesters(rows)).map((row) => this.toPoRow(row)),
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
    const [withRequester] = await this.withRequesters([docFields]);
    const detail: SapPurchaseOrderDetail = {
      document: this.toPoRow(withRequester),
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
    const columnQuery = parseColumnQuery(query, SAP_PR_FILTER_COLUMNS);
    if (isColumnQueryActive(columnQuery)) {
      const { rows } = await this.loadPurchaseRequests(query);
      return paginateRows(
        applyColumnQuery(rows, SAP_PR_FILTER_COLUMNS, columnQuery),
        page,
        limit,
      );
    }
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

  // ── Export (B1): mismos filtros que el listado, sin paginar, con tope ────

  async listAllForExport(
    entity: 'purchase_orders' | 'purchase_requests',
    query: SapDocQueryDto,
  ): Promise<{
    rows: Array<SapPurchaseOrderRow | SapPurchaseRequestRow>;
    truncated: boolean;
  }> {
    if (entity === 'purchase_orders') {
      const columnQuery = parseColumnQuery(query, SAP_PO_FILTER_COLUMNS);
      const { rows, truncated } = await this.loadPurchaseOrders(query);
      return {
        rows: applyColumnQuery(rows, SAP_PO_FILTER_COLUMNS, columnQuery),
        truncated,
      };
    }
    const columnQuery = parseColumnQuery(query, SAP_PR_FILTER_COLUMNS);
    const { rows, truncated } = await this.loadPurchaseRequests(query);
    return {
      rows: applyColumnQuery(rows, SAP_PR_FILTER_COLUMNS, columnQuery),
      truncated,
    };
  }

  // ── Facetas del filtro "tipo Excel" (E1) ─────────────────────────────────

  async purchaseOrderFacets(query: SapDocQueryDto) {
    const { rows } = await this.loadPurchaseOrders(query);
    return facetOf(rows, SAP_PO_FILTER_COLUMNS, query);
  }

  async purchaseRequestFacets(query: SapDocQueryDto) {
    const { rows } = await this.loadPurchaseRequests(query);
    return facetOf(rows, SAP_PR_FILTER_COLUMNS, query);
  }

  /** Vista completa con los filtros propios del listado (tope del export). */
  private async loadPurchaseOrders(
    query: SapDocQueryDto,
  ): Promise<{ rows: SapPurchaseOrderRow[]; truncated: boolean }> {
    const where = await this.poWhere(query);
    const rows = await this.prisma.sap_purchase_orders.findMany({
      where,
      select: PO_LIST_SELECT,
      orderBy: DOC_ORDER,
      take: EXPORT_MAX_ROWS + 1,
    });
    const kept = await this.withRequesters(rows.slice(0, EXPORT_MAX_ROWS));
    return {
      rows: kept.map((r) => this.toPoRow(r)),
      truncated: rows.length > EXPORT_MAX_ROWS,
    };
  }

  private async loadPurchaseRequests(
    query: SapDocQueryDto,
  ): Promise<{ rows: SapPurchaseRequestRow[]; truncated: boolean }> {
    const where = this.buildWhere(query, ['requester_name', 'requester']);
    const rows = await this.prisma.sap_purchase_requests.findMany({
      where,
      select: PR_LIST_SELECT,
      orderBy: DOC_ORDER,
      take: EXPORT_MAX_ROWS + 1,
    });
    return {
      rows: rows.slice(0, EXPORT_MAX_ROWS).map((r) => this.toPrRow(r)),
      truncated: rows.length > EXPORT_MAX_ROWS,
    };
  }

  // ── Cola de autorización (B5) ────────────────────────────────────────────

  async listApprovalRequests(
    query: SapApprovalQueryDto,
  ): Promise<PaginatedResponse<SapApprovalRequestRow>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const where: Record<string, unknown> = {};
    // Default: solo pendientes (es la bandeja); `status=all` trae todo.
    const status = query.status ?? 'pending';
    if (status === 'pending') where.status = 'arsPending';
    else if (status === 'approved') where.status = 'arsApproved';
    else if (status === 'rejected') where.status = 'arsNotApproved';
    if (query.kind === 'purchase_order') where.object_type = '22';
    else if (query.kind === 'purchase_request')
      where.object_type = '1470000113';
    const search = query.search?.trim();
    if (search) {
      const or: Record<string, unknown>[] = [
        { remarks: { contains: search, mode: 'insensitive' } },
        { originator_name: { contains: search, mode: 'insensitive' } },
        { requester_name: { contains: search, mode: 'insensitive' } },
        { card_name: { contains: search, mode: 'insensitive' } },
      ];
      if (/^\d+$/.test(search) && Number(search) <= 2_147_483_647) {
        or.push({ doc_num: Number(search) }, { code: Number(search) });
      }
      where.OR = or;
    }

    const [total, rows] = await Promise.all([
      this.prisma.sap_approval_requests.count({ where }),
      this.prisma.sap_approval_requests.findMany({
        where,
        select: APPROVAL_LIST_SELECT,
        orderBy: [
          { creation_date: { sort: 'desc', nulls: 'last' } },
          { code: 'desc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const today = new Date();
    return {
      data: rows.map((row) => this.toApprovalRow(row, today)),
      meta: buildMeta(total, page, limit),
    };
  }

  // ── Resumen (dashboard) ──────────────────────────────────────────────────

  async getSummary(year: number | null = null): Promise<SapSummary> {
    const [
      po,
      pr,
      approvalsTotal,
      approvalsPending,
      lastPoRun,
      lastPrRun,
      lastArRun,
      migradas,
    ] = await Promise.all([
      this.entitySummary('purchase_orders', year),
      this.entitySummary('purchase_requests', year),
      this.prisma.sap_approval_requests.count(),
      this.prisma.sap_approval_requests.count({
        where: { status: 'arsPending' },
      }),
      this.lastRun('purchase_orders'),
      this.lastRun('purchase_requests'),
      this.lastRun('approval_requests'),
      // D1: OC creadas desde Maximo; `en_maximo` = existen allá (se
      // descuentan en los totales combinados del dashboard).
      this.prisma.$queryRaw<Array<{ total: number; en_maximo: number }>>(
        Prisma.sql`
          SELECT count(*) FILTER (WHERE maximo_ponum IS NOT NULL)::int AS total,
                 count(*) FILTER (WHERE maximo_ponum IS NOT NULL AND EXISTS (
                   SELECT 1 FROM maximo_purchase_orders m
                   WHERE m.ponum = sap_purchase_orders.maximo_ponum))::int AS en_maximo
          FROM sap_purchase_orders
          WHERE cancelled IS DISTINCT FROM true ${andYear('doc_date', year)}`,
      ),
    ]);
    return {
      syncEnabled: this.isSyncEnabled(),
      year,
      purchaseOrders: po,
      purchaseRequests: pr,
      approvalRequests: { total: approvalsTotal, pending: approvalsPending },
      migradas: {
        total: Number(migradas[0]?.total ?? 0),
        en_maximo: Number(migradas[0]?.en_maximo ?? 0),
      },
      lastSync: {
        purchase_orders: lastPoRun,
        purchase_requests: lastPrRun,
        approval_requests: lastArRun,
      },
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

  /**
   * Filtros de OC: además de proveedor/número, la búsqueda encuentra al
   * solicitante (vive en la solicitud base) y a quien capturó la OC.
   */
  private async poWhere(
    query: SapDocQueryDto,
  ): Promise<Record<string, unknown>> {
    const search = query.search?.trim();
    const extra: Record<string, unknown>[] = [];
    if (search) {
      const requests = await this.prisma.sap_purchase_requests.findMany({
        where: {
          OR: [
            { requester_name: { contains: search, mode: 'insensitive' } },
            { requester: { contains: search, mode: 'insensitive' } },
          ],
        },
        select: { doc_entry: true },
      });
      if (requests.length > 0) {
        extra.push({
          base_request_entries: { hasSome: requests.map((r) => r.doc_entry) },
        });
      }
    }
    const where = this.buildWhere(
      query,
      ['card_name', 'card_code', 'created_by_name', 'maximo_ponum'],
      extra,
    );
    // D1: origen de la OC (capturada en SAP vs. creada desde Maximo)
    if (query.origin === 'maximo') {
      return { AND: [where, { maximo_ponum: { not: null } }] };
    }
    if (query.origin === 'sap') {
      return { AND: [where, { maximo_ponum: null }] };
    }
    return where;
  }

  /**
   * Solicitante de cada OC: requester_name de sus solicitudes base de SAP
   * y, si la creó la integración con Maximo, el REQUESTEDBY de esa OC en
   * Maximo (vista vigente).
   */
  private async withRequesters<
    T extends {
      base_request_entries: number[];
      maximo_ponum: string | null;
      created_by_name: string | null;
    },
  >(
    rows: T[],
  ): Promise<
    Array<
      T & {
        requester_names: string[];
        maximo_requested_by: string | null;
        maximo_po_exists: boolean;
        buyer_name: string | null;
        buyer_kind: BuyerKind;
      }
    >
  > {
    const entries = [...new Set(rows.flatMap((r) => r.base_request_entries))];
    const ponums = [
      ...new Set(
        rows.map((r) => r.maximo_ponum).filter((p): p is string => p !== null),
      ),
    ];
    const names = new Map<number, string>();
    const maximoRequesters = new Map<string, string>();
    const maximoBuyers = new Map<string, string>();
    const maximoExists = new Set<string>();
    const [requests, maximo] = await Promise.all([
      entries.length === 0
        ? []
        : this.prisma.sap_purchase_requests.findMany({
            where: { doc_entry: { in: entries } },
            select: { doc_entry: true, requester_name: true, requester: true },
          }),
      ponums.length === 0
        ? []
        : this.prisma.$queryRaw<
            Array<{
              ponum: string;
              requested_by: string | null;
              purchase_agent: string | null;
              purchase_agent_name: string | null;
            }>
          >(Prisma.sql`
            SELECT DISTINCT ON (ponum) ponum, requested_by,
                   purchase_agent, purchase_agent_name
            FROM maximo_purchase_orders
            WHERE ponum IN (${Prisma.join(ponums)})
            ORDER BY ponum, coalesce(revisionnum, 0) DESC`),
    ]);
    for (const r of requests) {
      const name = r.requester_name ?? r.requester;
      if (name) names.set(r.doc_entry, name);
    }
    // D6/E4: REQUESTEDBY y PURCHASEAGENT de Maximo son códigos → alias.
    const aliasNames = await this.aliases.resolveMany('maximo', [
      ...maximo.map((m) => m.requested_by),
      ...maximo.map((m) => m.purchase_agent ?? null),
    ]);
    for (const m of maximo) {
      maximoExists.add(m.ponum);
      if (m.requested_by) {
        maximoRequesters.set(
          m.ponum,
          aliasNames.get(m.requested_by) ?? m.requested_by,
        );
      }
      const buyer = maximoBuyerName(
        m.purchase_agent ?? null,
        m.purchase_agent_name ?? null,
        aliasNames,
      );
      if (buyer) maximoBuyers.set(m.ponum, buyer);
    }
    return rows.map((row) => {
      const maximoBuyer =
        row.maximo_ponum === null
          ? undefined
          : maximoBuyers.get(row.maximo_ponum);
      // Una OC migrada la capturó el usuario de la integración (no es su
      // comprador): si existe en Maximo, el comprador es el de allá o nadie.
      const capturer =
        row.maximo_ponum !== null && maximoExists.has(row.maximo_ponum)
          ? null
          : row.created_by_name;
      return {
        ...row,
        buyer_name: maximoBuyer ?? capturer,
        buyer_kind: (maximoBuyer
          ? 'comprador'
          : capturer
            ? 'capturo'
            : null) as BuyerKind,
        maximo_po_exists:
          row.maximo_ponum !== null && maximoExists.has(row.maximo_ponum),
        maximo_requested_by:
          row.maximo_ponum === null
            ? null
            : (maximoRequesters.get(row.maximo_ponum) ?? null),
        requester_names: [
          ...new Set(
            row.base_request_entries
              .map((entry) => names.get(entry))
              .filter((name): name is string => !!name),
          ),
        ],
      };
    });
  }

  private buildWhere(
    query: SapDocQueryDto,
    searchFields: string[],
    extraSearch: Record<string, unknown>[] = [],
  ): Record<string, unknown> {
    const and: Record<string, unknown>[] = [];
    if (query.status && query.status.length > 0) {
      and.push({ OR: query.status.map(statusCondition) });
    }
    if (query.from || query.to) {
      and.push({
        doc_date: {
          ...(query.from ? { gte: new Date(query.from) } : {}),
          ...(query.to ? { lte: new Date(query.to) } : {}),
        },
      });
    }
    // D4: año calendario (rango sobre doc_date para usar el índice)
    if (query.year) {
      and.push({
        doc_date: {
          gte: new Date(Date.UTC(query.year, 0, 1)),
          lt: new Date(Date.UTC(query.year + 1, 0, 1)),
        },
      });
    }
    const search = query.search?.trim();
    if (search) {
      const or: Record<string, unknown>[] = searchFields.map((field) => ({
        [field]: { contains: search, mode: 'insensitive' },
      }));
      or.push(...extraSearch);
      // Solo si cabe en un entero de 32 bits (columnas Int de Postgres):
      // un número más largo haría reventar la consulta con 500.
      if (/^\d+$/.test(search) && Number(search) <= 2_147_483_647) {
        or.push({ doc_num: Number(search) });
        or.push({ doc_entry: Number(search) });
      }
      and.push({ OR: or });
    }
    if (and.length === 0) return {};
    if (and.length === 1) return and[0];
    return { AND: and };
  }

  /**
   * Agregados del resumen en SQL (regla del sprint: agregar en BD, no en
   * memoria; montos POR MONEDA, nunca sumados entre monedas).
   */
  private async entitySummary(
    entity: 'purchase_orders' | 'purchase_requests',
    year: number | null = null,
  ): Promise<SapEntitySummary> {
    const table =
      entity === 'purchase_orders'
        ? Prisma.sql`sap_purchase_orders`
        : Prisma.sql`sap_purchase_requests`;
    const inYear = andYear('doc_date', year);
    const [byStatus, byCurrency, openByCurrency, agg, gestion] =
      await Promise.all([
        this.prisma.$queryRaw<
          Array<{
            document_status: string | null;
            cancelled: boolean | null;
            count: number;
          }>
        >(Prisma.sql`
          SELECT document_status, cancelled, count(*)::int AS count
          FROM ${table} WHERE true ${inYear} GROUP BY document_status, cancelled`),
        this.prisma.$queryRaw<
          Array<{ currency: string | null; total: unknown; count: number }>
        >(Prisma.sql`
          SELECT currency, coalesce(sum(doc_total), 0) AS total, count(*)::int AS count
          FROM ${table} WHERE cancelled IS DISTINCT FROM true ${inYear}
          GROUP BY currency ORDER BY total DESC`),
        this.prisma.$queryRaw<
          Array<{ currency: string | null; total: unknown; count: number }>
        >(Prisma.sql`
          SELECT currency, coalesce(sum(doc_total), 0) AS total, count(*)::int AS count
          FROM ${table}
          WHERE document_status = 'bost_Open' AND cancelled IS DISTINCT FROM true ${inYear}
          GROUP BY currency ORDER BY total DESC`),
        this.prisma.$queryRaw<
          Array<{
            total: number;
            monto: unknown;
            lines_total: number;
            lines_classified: number;
            con_ahorro: number;
          }>
        >(Prisma.sql`
          SELECT count(*)::int AS total,
                 coalesce(sum(doc_total), 0) AS monto,
                 coalesce(sum(lines_total), 0)::int AS lines_total,
                 coalesce(sum(lines_classified), 0)::int AS lines_classified,
                 count(*) FILTER (WHERE ahorro_total IS NOT NULL)::int AS con_ahorro
          FROM ${table} WHERE true ${inYear}`),
        // Días de gestión: cerradas no canceladas; closing_date (0011) o,
        // como proxy documentado, update_date_source. null si no hay base.
        this.prisma.$queryRaw<Array<{ dias: unknown }>>(Prisma.sql`
          SELECT avg(extract(epoch FROM (coalesce(closing_date, update_date_source) - doc_date)) / 86400) AS dias
          FROM ${table}
          WHERE document_status = 'bost_Close' AND cancelled IS DISTINCT FROM true
            AND doc_date IS NOT NULL
            AND coalesce(closing_date, update_date_source) IS NOT NULL
            AND coalesce(closing_date, update_date_source) >= doc_date ${inYear}`),
      ]);

    const counts = new Map<string, number>();
    for (const row of byStatus) {
      const key = deriveStatusKey(row) ?? row.document_status ?? 'sin_estatus';
      counts.set(key, (counts.get(key) ?? 0) + Number(row.count));
    }
    const statusCounts: SapStatusCount[] = [...counts.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);
    const toCurrency = (rows: typeof byCurrency): SapCurrencyAmount[] =>
      rows.map((r) => ({
        currency: r.currency,
        total: toNumber(r.total) ?? 0,
        count: Number(r.count),
      }));
    const openAmounts = toCurrency(openByCurrency);
    const dias = toNumber(gestion[0]?.dias);

    return {
      total: Number(agg[0]?.total ?? 0),
      byStatus: statusCounts,
      montoTotal: toNumber(agg[0]?.monto) ?? 0,
      montoPorMoneda: toCurrency(byCurrency),
      abiertas: {
        count: openAmounts.reduce((sum, r) => sum + r.count, 0),
        montoPorMoneda: openAmounts,
      },
      linesTotal: Number(agg[0]?.lines_total ?? 0),
      linesClassified: Number(agg[0]?.lines_classified ?? 0),
      docsConAhorro: Number(agg[0]?.con_ahorro ?? 0),
      diasPromedioGestion: dias === null ? null : Math.round(dias * 10) / 10,
    };
  }

  private async lastRun(
    target: 'purchase_orders' | 'purchase_requests' | 'approval_requests',
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
    open_total: unknown;
    document_status: string | null;
    cancelled: boolean | null;
    [key: string]: unknown;
  }): SapPurchaseOrderRow {
    return {
      ...(row as unknown as SapPurchaseOrderRow),
      status_key: deriveStatusKey(row),
      doc_total: toNumber(row.doc_total),
      ahorro_total: toNumber(row.ahorro_total),
      open_total: toNumber(row.open_total),
    };
  }

  private toPrRow(row: {
    doc_total: unknown;
    ahorro_total: unknown;
    document_status: string | null;
    cancelled: boolean | null;
    [key: string]: unknown;
  }): SapPurchaseRequestRow {
    return {
      ...(row as unknown as SapPurchaseRequestRow),
      status_key: deriveStatusKey(row),
      doc_total: toNumber(row.doc_total),
      ahorro_total: toNumber(row.ahorro_total),
    };
  }

  private toApprovalRow(
    row: {
      doc_total: unknown;
      approvers: unknown;
      object_type: string | null;
      status: string | null;
      creation_date: Date | null;
      [key: string]: unknown;
    },
    today: Date,
  ): SapApprovalRequestRow {
    const approvers = Array.isArray(row.approvers)
      ? (row.approvers as SapApprovalLineView[])
      : [];
    const daysWaiting =
      row.status === 'arsPending' && row.creation_date
        ? Math.max(
            0,
            Math.floor(
              (today.getTime() - row.creation_date.getTime()) / MS_PER_DAY,
            ),
          )
        : null;
    return {
      ...(row as unknown as SapApprovalRequestRow),
      document_kind:
        (row.object_type && OBJECT_TYPE_KIND[row.object_type]) || 'other',
      doc_total: toNumber(row.doc_total),
      approvers,
      days_waiting: daysWaiting,
    };
  }
}
