import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaginatedResponse } from '../common/interfaces/paginated-response.interface';
import {
  andBetween,
  andYear,
  CURRENT_MAXIMO_CONTRACTS,
  CURRENT_MAXIMO_POS,
  CURRENT_MAXIMO_PRS,
  MAXIMO_PRS_WITH_PO,
  maximoContractPrPending,
  maximoPrInApproval,
  maximoPrLlegada,
  maximoPrPending,
} from '../common/sql/erp-views.sql';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import { maximoVendorNote } from '../erp-vendors/maximo-vendor-xref';
import type { EffectiveVendor } from '../erp-vendors/maximo-vendor-xref';
import { rangeEnd } from '../common/utils/date-range.util';
import {
  applyColumnQuery,
  facetOf,
  isColumnQueryActive,
  paginateRows,
  parseColumnQuery,
} from '../common/column-filters/column-filters';
import { maximoBuyer } from '../common/utils/buyer.util';
import type { Buyer } from '../common/utils/buyer.util';
import {
  MAXIMO_CONTRACT_FILTER_COLUMNS,
  MAXIMO_PO_FILTER_COLUMNS,
  MAXIMO_REQUEST_FILTER_COLUMNS,
} from './maximo-records.columns';
import {
  groupContracts,
  MAXIMO_CONTRACT_GROUP_FILTER_COLUMNS,
} from './maximo-contract-groups';
import type { MaximoContractGroupView } from './maximo-contract-groups';
import {
  deriveContractLines,
  deriveContractStatusHistory,
} from './maximo-contract-raw';
import {
  isMaximoRequestsView,
  MaximoContractQueryDto,
} from './dto/maximo-contract-query.dto';
import { MaximoPoQueryDto } from './dto/maximo-po-query.dto';
import {
  MaximoContractDetail,
  MaximoContractView,
  MaximoLastSyncRun,
  MaximoPrStatusEntry,
  MaximoPurchaseOrderDetail,
  MaximoPurchaseOrderView,
  MaximoStatusCount,
  MaximoSummary,
  SupplierFields,
} from './maximo-records.types';

/**
 * Fase INT-5 — Lectura de dominio sobre el staging de Maximo. SOLO lee
 * `maximo_purchase_orders` / `maximo_contracts` / `maximo_sync_runs`; el
 * único escritor sigue siendo el sync de Int-3. Sin dependencia de la capa
 * de integración (criterio de aceptación por grep).
 *
 * "Vista actual" (mayor revisión por clave natural): se resuelve con
 * `DISTINCT ON` vía `$queryRaw` tipado — primer uso de SQL crudo en el repo,
 * elegido porque el query builder de Prisma no expresa DISTINCT ON y la
 * alternativa (groupBy + segundo fetch) no permite filtrar por los valores de
 * la revisión vigente ni paginar en SQL. Los ORDER BY de las CTEs calzan con
 * los índices únicos de clave natural de `0005_maximo_staging.sql`
 * (expresiones coalesce idénticas), así que no hizo falta índice nuevo.
 * Bloque K (2026-10-05): las vistas se importan de common/sql/erp-views
 * (una sola definición); la de contratos ya excluye las obsoletas (K8).
 *
 * Bloque 2026-09-23:
 *  - D4: `year` (created_at_source) en listados y resumen.
 *  - D6: `requested_by_name` / `approved_by_name` = alias de Maximo cuando
 *    existe (si no, null y la UI muestra el código).
 *  - D7: `pr_total` (monto de la PR, PR.TOTALCOST de AB_CONTRATOS, base
 *    desconocida) — null = sin dato.
 *  - D8: `consumed_value` y `balance_value` (valor − consumido) en contratos.
 *
 * Pedidos de Ingrid 2026-09-25:
 *  - E1: filtro "tipo Excel" por columna. Sin filtros por columna ni orden
 *    el listado sigue paginado en SQL; con ellos se evalúa sobre la vista
 *    actual completa (mismo loader que el export).
 *  - E4: comprador de la OC (`purchase_agent`, migración 0014) con su
 *    nombre: alias de Compras > DISPLAYNAME de Maximo > usuario. F1: sin
 *    PURCHASEAGENT, "Capturó: …" = quién la creó (`created_by`, 0015).
 *  - E2 (parte independiente): `group=contract` agrupa por contrato (una
 *    fila por contractnum con sus PR) — ver maximo-contract-groups.ts.
 *
 * Reunión con Ingrid 2026-09-28:
 *  - G1: proveedor EFECTIVO (`supplier_*`): el de SAP si la OC migró o por
 *    el cruce de su código; si no, el de Maximo. Columna, faceta, detalle y
 *    export lo usan; `proveedor` (llave) + `from`/`to` filtran desde el top
 *    de Reportes. Los contratos aplican el cruce por código.
 *
 * Bloque K (2026-10-05, K4.4): `vista=solicitudes` (o `sin_oc`,
 * `contrato_sin_oc`, `en_aprobacion`, `pr_status`) lee `CURRENT_MAXIMO_PRS`,
 * una fila por PR, con el estatus y las fechas DE LA PR (pendientes = APPR
 * sin OC ni contrato, ver erp-views). Sin ella, Contratos y el agrupado
 * quedan como antes. El folio ya no ubica a las PR.
 */

/** Columnas del listado de POs (excluye `raw`: solo viaja en el detalle). */
const PO_LIST_COLUMNS = Prisma.sql`
  id, ponum, siteid, revisionnum, status, description, vendor_id, vendor_name,
  total_cost, currency, ab_ahorro, ab_tipocomp, ab_clasfpo, requested_by,
  purchase_agent, purchase_agent_name, created_by,
  department, approved_at, approved_by, waiting_approval_at, created_at_source,
  last_changed_at, last_seen_at`;

// K4.4: los `pr_*` van en las dos vistas (el agrupado los lleva en `prs[]`)
const CONTRACT_LIST_COLUMNS = Prisma.sql`
  id, prnum, contractnum, revisionnum, status, maxvol, total_cost, currency,
  start_date, end_date, vendor_id, vendor_name, requested_by, department,
  approved_at, approved_by, created_at_source, contract_ref_num, contract_value,
  pr_total, consumed_value,
  pr_status, pr_issue_date, pr_approved_at, pr_status_date,
  purchview_count, has_contract, last_changed_at, last_seen_at,
  (prnum IS NOT NULL AND prnum IN (${MAXIMO_PRS_WITH_PO})) AS has_po`;

/**
 * K4.4: base, orden y columnas filtrables según la vista. Solicitudes = una
 * fila por PR, de la más nueva a la más vieja; Contratos, como antes.
 */
function contractView(query: MaximoContractQueryDto) {
  return isMaximoRequestsView(query)
    ? {
        base: CURRENT_MAXIMO_PRS,
        order: Prisma.sql`ORDER BY c.pr_issue_date DESC NULLS LAST, c.prnum DESC`,
        columns: MAXIMO_REQUEST_FILTER_COLUMNS,
      }
    : {
        base: CURRENT_MAXIMO_CONTRACTS,
        order: Prisma.sql`ORDER BY c.end_date DESC NULLS LAST,
          coalesce(c.prnum, '') ASC, coalesce(c.contractnum, '') ASC`,
        columns: MAXIMO_CONTRACT_FILTER_COLUMNS,
      };
}

/** Tope del export (B1). */
const EXPORT_MAX_ROWS = 20_000;

/** Campos de comprador de la vista (E4/F1). */
const buyerFields = (buyer: Buyer) => ({
  buyer_name: buyer.name,
  buyer_kind: buyer.kind,
});

/** G1: proveedor efectivo en la vista. */
const supplierFields = (vendor: EffectiveVendor): SupplierFields => ({
  supplier_key: vendor.key,
  supplier_code: vendor.code,
  supplier_name: vendor.name,
  supplier_source: vendor.source,
  supplier_note: maximoVendorNote(vendor),
});

const NO_SUPPLIER: SupplierFields = {
  supplier_key: null,
  supplier_code: null,
  supplier_name: null,
  supplier_source: null,
  supplier_note: null,
};

type SupplierKey = keyof SupplierFields;

/** Filas crudas del driver: numerics llegan como Prisma.Decimal. */
type PoSqlRow = Omit<
  MaximoPurchaseOrderView,
  | 'total_cost'
  | 'ab_ahorro'
  | 'raw'
  | 'requested_by_name'
  | 'approved_by_name'
  | 'buyer_name'
  | 'buyer_kind'
  | SupplierKey
> & { total_cost: unknown; ab_ahorro: unknown };

type ContractSqlRow = Omit<
  MaximoContractView,
  | 'maxvol'
  | 'total_cost'
  | 'contract_value'
  | 'pr_total'
  | 'consumed_value'
  | 'balance_value'
  | 'raw'
  | 'requested_by_name'
  | 'approved_by_name'
  | SupplierKey
> & {
  maxvol: unknown;
  total_cost: unknown;
  contract_value: unknown;
  pr_total: unknown;
  consumed_value: unknown;
};

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
export class MaximoRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly aliases: ErpAliasesService,
    private readonly vendors: MaximoVendorXrefService,
  ) {}

  // ── Purchase orders ─────────────────────────────────────────────────────

  /** WHERE del listado de POs (compartido con el export). */
  private poWhere(query: MaximoPoQueryDto): Prisma.Sql {
    const conditions: Prisma.Sql[] = [];
    if (query.status && query.status.length > 0) {
      conditions.push(Prisma.sql`c.status IN (${Prisma.join(query.status)})`);
    }
    if (query.department)
      conditions.push(Prisma.sql`c.department = ${query.department}`);
    if (query.vendor_name)
      conditions.push(
        Prisma.sql`c.vendor_name ILIKE ${`%${query.vendor_name}%`}`,
      );
    if (query.ab_clasfpo)
      conditions.push(Prisma.sql`c.ab_clasfpo = ${query.ab_clasfpo}`);
    if (query.approved_from)
      conditions.push(
        Prisma.sql`c.approved_at >= ${new Date(query.approved_from)}`,
      );
    if (query.approved_to)
      conditions.push(
        Prisma.sql`c.approved_at <= ${new Date(query.approved_to)}`,
      );
    if (query.search) {
      const term = `%${query.search}%`;
      conditions.push(
        Prisma.sql`(c.ponum ILIKE ${term} OR c.description ILIKE ${term})`,
      );
    }
    if (query.year) {
      conditions.push(
        Prisma.sql`true ${andYear('c.created_at_source', query.year)}`,
      );
    }
    // G1: periodo del top de proveedores (fecha de la OC en Maximo)
    if (query.from)
      conditions.push(
        Prisma.sql`c.created_at_source >= ${new Date(query.from)}`,
      );
    if (query.to)
      conditions.push(Prisma.sql`c.created_at_source <= ${rangeEnd(query.to)}`);
    return conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;
  }

  async listPurchaseOrders(
    query: MaximoPoQueryDto,
  ): Promise<PaginatedResponse<MaximoPurchaseOrderView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    // E1: filtros por columna u orden → sobre la vista actual completa
    // (G1: el proveedor efectivo se resuelve en memoria, igual)
    const columnQuery = parseColumnQuery(query, MAXIMO_PO_FILTER_COLUMNS);
    if (isColumnQueryActive(columnQuery) || query.proveedor) {
      const { rows } = await this.loadPurchaseOrders(query);
      return paginateRows(
        applyColumnQuery(rows, MAXIMO_PO_FILTER_COLUMNS, columnQuery),
        page,
        limit,
      );
    }
    const where = this.poWhere(query);

    const [rows, counts] = await Promise.all([
      this.prisma.$queryRaw<PoSqlRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT ${PO_LIST_COLUMNS}
        FROM current c
        ${where}
        ORDER BY c.approved_at DESC NULLS LAST, c.ponum ASC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT count(*)::int AS count FROM current c ${where}`),
    ]);

    return {
      data: await this.enrichPos(rows.map((row) => this.mapPoRow(row))),
      meta: buildMeta(counts[0]?.count ?? 0, page, limit),
    };
  }

  /** Export (B1): mismos filtros que el listado, sin paginar, con tope. */
  async listPurchaseOrdersForExport(
    query: MaximoPoQueryDto,
  ): Promise<{ rows: MaximoPurchaseOrderView[]; truncated: boolean }> {
    const columnQuery = parseColumnQuery(query, MAXIMO_PO_FILTER_COLUMNS);
    const { rows, truncated } = await this.loadPurchaseOrders(query);
    return {
      rows: applyColumnQuery(rows, MAXIMO_PO_FILTER_COLUMNS, columnQuery),
      truncated,
    };
  }

  /** E1: valores de una columna con los demás filtros aplicados. */
  async purchaseOrderFacets(query: MaximoPoQueryDto) {
    const { rows } = await this.loadPurchaseOrders(query);
    return facetOf(rows, MAXIMO_PO_FILTER_COLUMNS, query);
  }

  /** Vista actual completa con los filtros propios del listado (tope). */
  private async loadPurchaseOrders(
    query: MaximoPoQueryDto,
  ): Promise<{ rows: MaximoPurchaseOrderView[]; truncated: boolean }> {
    const where = this.poWhere(query);
    const rows = await this.prisma.$queryRaw<PoSqlRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT ${PO_LIST_COLUMNS}
        FROM current c
        ${where}
        ORDER BY c.approved_at DESC NULLS LAST, c.ponum ASC
        LIMIT ${EXPORT_MAX_ROWS + 1}`);
    const enriched = await this.enrichPos(
      rows.slice(0, EXPORT_MAX_ROWS).map((row) => this.mapPoRow(row)),
    );
    return {
      rows: query.proveedor
        ? enriched.filter((r) => r.supplier_key === query.proveedor)
        : enriched,
      truncated: rows.length > EXPORT_MAX_ROWS,
    };
  }

  async listContractsForExport(
    query: MaximoContractQueryDto,
  ): Promise<{ rows: MaximoContractView[]; truncated: boolean }> {
    const { columns } = contractView(query);
    const columnQuery = parseColumnQuery(query, columns);
    const { rows, truncated } = await this.loadContracts(query);
    return {
      rows: applyColumnQuery(rows, columns, columnQuery),
      truncated,
    };
  }

  // ── Agrupado por contrato (E2) ──────────────────────────────────────────

  async listContractGroups(
    query: MaximoContractQueryDto,
  ): Promise<PaginatedResponse<MaximoContractGroupView>> {
    const columnQuery = parseColumnQuery(
      query,
      MAXIMO_CONTRACT_GROUP_FILTER_COLUMNS,
    );
    const { rows } = await this.loadContractGroups(query);
    return paginateRows(
      applyColumnQuery(rows, MAXIMO_CONTRACT_GROUP_FILTER_COLUMNS, columnQuery),
      query.page ?? 1,
      query.limit ?? 20,
    );
  }

  async listContractGroupsForExport(
    query: MaximoContractQueryDto,
  ): Promise<{ rows: MaximoContractGroupView[]; truncated: boolean }> {
    const columnQuery = parseColumnQuery(
      query,
      MAXIMO_CONTRACT_GROUP_FILTER_COLUMNS,
    );
    const { rows, truncated } = await this.loadContractGroups(query);
    return {
      rows: applyColumnQuery(
        rows,
        MAXIMO_CONTRACT_GROUP_FILTER_COLUMNS,
        columnQuery,
      ),
      truncated,
    };
  }

  async contractGroupFacets(query: MaximoContractQueryDto) {
    const { rows } = await this.loadContractGroups(query);
    return facetOf(rows, MAXIMO_CONTRACT_GROUP_FILTER_COLUMNS, query);
  }

  /** Solo filas con contrato (una PR sin contrato no forma grupo). */
  private async loadContractGroups(
    query: MaximoContractQueryDto,
  ): Promise<{ rows: MaximoContractGroupView[]; truncated: boolean }> {
    const { rows, truncated } = await this.loadContracts(
      Object.assign(new MaximoContractQueryDto(), query, {
        has_contract: 'true' as const,
      }),
    );
    return { rows: groupContracts(rows), truncated };
  }

  /** E1: valores de una columna con los demás filtros aplicados. */
  async contractFacets(query: MaximoContractQueryDto) {
    const { rows } = await this.loadContracts(query);
    return facetOf(rows, contractView(query).columns, query);
  }

  /** Vista actual completa con los filtros propios del listado (tope). */
  private async loadContracts(
    query: MaximoContractQueryDto,
  ): Promise<{ rows: MaximoContractView[]; truncated: boolean }> {
    const { base, order } = contractView(query);
    const where = this.contractWhere(query);
    const rows = await this.prisma.$queryRaw<ContractSqlRow[]>(Prisma.sql`
        WITH current AS (${base})
        SELECT ${CONTRACT_LIST_COLUMNS}
        FROM current c
        ${where}
        ${order}
        LIMIT ${EXPORT_MAX_ROWS + 1}`);
    const enriched = await this.enrichContracts(
      rows.slice(0, EXPORT_MAX_ROWS).map((row) => this.mapContractRow(row)),
    );
    return {
      rows: query.proveedor
        ? enriched.filter((r) => r.supplier_key === query.proveedor)
        : enriched,
      truncated: rows.length > EXPORT_MAX_ROWS,
    };
  }

  async getPurchaseOrder(
    ponum: string,
    includeRaw: boolean,
  ): Promise<MaximoPurchaseOrderDetail> {
    const rows = await this.prisma.maximo_purchase_orders.findMany({
      where: { ponum },
    });
    if (rows.length === 0) {
      throw new NotFoundException(`PO ${ponum} no existe en staging Maximo`);
    }
    const sorted = [...rows].sort(
      (a, b) => (b.revisionnum ?? -1) - (a.revisionnum ?? -1),
    );
    const current = sorted[0];
    const [view] = await this.enrichPos([this.mapPoRow(current)]);
    return {
      current: {
        ...view,
        ...(includeRaw ? { raw: current.raw } : {}),
      },
      revisions: sorted.map((row) => ({
        id: row.id,
        revisionnum: row.revisionnum,
        siteid: row.siteid,
        status: row.status,
        rowstamp: row.rowstamp,
        last_changed_at: row.last_changed_at,
        last_seen_at: row.last_seen_at,
      })),
    };
  }

  // ── Contracts ───────────────────────────────────────────────────────────

  /**
   * K4.4: periodo de la vista de solicitudes. Con `sin_oc`/`contrato_sin_oc`
   * va por la llegada a Compras (`maximoPrLlegada`, cuadra con la tarjeta de
   * pendientes); si no, por la creación de la PR (`pr_issue_date`). `year`
   * gana sobre `pr_desde`.
   */
  private requestPeriod(query: MaximoContractQueryDto): Prisma.Sql | null {
    const pending = query.sin_oc === 'true' || query.contrato_sin_oc === 'true';
    const fecha = pending ? maximoPrLlegada('c') : Prisma.sql`c.pr_issue_date`;
    if (query.year) {
      return Prisma.sql`true ${andBetween(
        fecha,
        new Date(Date.UTC(query.year, 0, 1)),
        new Date(Date.UTC(query.year + 1, 0, 1)),
      )}`;
    }
    if (query.pr_desde) {
      return Prisma.sql`true ${andBetween(fecha, new Date(query.pr_desde), null)}`;
    }
    return null;
  }

  /** WHERE del listado de contratos (compartido con el export). */
  private contractWhere(query: MaximoContractQueryDto): Prisma.Sql {
    const conditions: Prisma.Sql[] = [];
    if (isMaximoRequestsView(query)) {
      // K4: PR pendientes de gestionar = APPR sin contrato ni OC vigente
      if (query.sin_oc === 'true') conditions.push(maximoPrPending('c'));
      // I8: APPR de contrato sin OC (la OC se genera en automático), aparte
      if (query.contrato_sin_oc === 'true') {
        conditions.push(maximoContractPrPending('c'));
      }
      // K4.4: en aprobación (WAPPR), todavía no llegan a Compras
      if (query.en_aprobacion === 'true') {
        conditions.push(maximoPrInApproval('c'));
      }
      if (query.pr_status && query.pr_status.length > 0) {
        conditions.push(
          Prisma.sql`c.pr_status IN (${Prisma.join(query.pr_status)})`,
        );
      }
      const period = this.requestPeriod(query);
      if (period) conditions.push(period);
    } else if (query.year) {
      // Contratos: el año va por la fecha del contrato, como antes
      conditions.push(
        Prisma.sql`true ${andYear('c.created_at_source', query.year)}`,
      );
    }
    if (query.status && query.status.length > 0) {
      conditions.push(Prisma.sql`c.status IN (${Prisma.join(query.status)})`);
    }
    if (query.has_contract)
      conditions.push(
        Prisma.sql`c.has_contract = ${query.has_contract === 'true'}`,
      );
    if (query.department)
      conditions.push(Prisma.sql`c.department = ${query.department}`);
    if (query.vendor_name)
      conditions.push(
        Prisma.sql`c.vendor_name ILIKE ${`%${query.vendor_name}%`}`,
      );
    if (query.end_from)
      conditions.push(Prisma.sql`c.end_date >= ${new Date(query.end_from)}`);
    if (query.end_to)
      conditions.push(Prisma.sql`c.end_date <= ${new Date(query.end_to)}`);
    if (query.search) {
      const term = `%${query.search}%`;
      conditions.push(
        Prisma.sql`(c.prnum ILIKE ${term} OR c.contractnum ILIKE ${term} OR c.vendor_name ILIKE ${term})`,
      );
    }
    return conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;
  }

  async listContracts(
    query: MaximoContractQueryDto,
  ): Promise<PaginatedResponse<MaximoContractView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const { base, order, columns } = contractView(query);
    const columnQuery = parseColumnQuery(query, columns);
    if (isColumnQueryActive(columnQuery) || query.proveedor) {
      const { rows } = await this.loadContracts(query);
      return paginateRows(
        applyColumnQuery(rows, columns, columnQuery),
        page,
        limit,
      );
    }
    const where = this.contractWhere(query);

    const [rows, counts] = await Promise.all([
      this.prisma.$queryRaw<ContractSqlRow[]>(Prisma.sql`
        WITH current AS (${base})
        SELECT ${CONTRACT_LIST_COLUMNS}
        FROM current c
        ${where}
        ${order}
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        WITH current AS (${base})
        SELECT count(*)::int AS count FROM current c ${where}`),
    ]);

    return {
      data: await this.enrichContracts(
        rows.map((row) => this.mapContractRow(row)),
      ),
      meta: buildMeta(counts[0]?.count ?? 0, page, limit),
    };
  }

  /**
   * Detalle por clave: `key` es el prnum, o el contractnum para las filas de
   * contrato directo que no traen PR (existen en Maximo real y en el seed) —
   * la ruta del doc era `/:prnum`, pero con prnum null serían inalcanzables.
   *
   * K3/K8 (2026-10-05): como las vistas, ignora las revisiones obsoletas
   * (`superseded_at`): `current` es la revisión más alta vigente y la lista
   * de revisiones solo trae las vigentes. Líneas e historial del contrato
   * salen del raw canonizado (el de prod es anidado); el historial de la PR,
   * de `maximo_pr_status_history`, con el nombre por alias (D6).
   */
  async getContract(
    key: string,
    includeRaw: boolean,
  ): Promise<MaximoContractDetail> {
    const rows = await this.prisma.maximo_contracts.findMany({
      where: {
        OR: [{ prnum: key }, { AND: [{ prnum: null }, { contractnum: key }] }],
      },
    });
    const vigentes = rows.filter((row) => !row.superseded_at);
    if (vigentes.length === 0) {
      throw new NotFoundException(
        `Contrato/PR ${key} no existe en staging Maximo`,
      );
    }
    const sorted = [...vigentes].sort(
      (a, b) => (b.revisionnum ?? -1) - (a.revisionnum ?? -1),
    );
    const current = sorted[0];
    const [withPo, prStatusHistory] = await Promise.all([
      // I8: ¿alguna OC vigente usa la PR? (en el listado sale del SELECT)
      current.prnum
        ? this.prisma.$queryRaw<Array<{ has_po: boolean }>>(Prisma.sql`
            SELECT ${current.prnum} IN (${MAXIMO_PRS_WITH_PO}) AS has_po`)
        : null,
      this.prStatusHistory(current.prnum),
    ]);
    const [view] = await this.enrichContracts([
      this.mapContractRow({ ...current, has_po: withPo?.[0]?.has_po === true }),
    ]);
    return {
      current: {
        ...view,
        ...(includeRaw ? { raw: current.raw } : {}),
      },
      revisions: sorted.map((row) => ({
        id: row.id,
        contractnum: row.contractnum,
        revisionnum: row.revisionnum,
        status: row.status,
        pr_rowstamp: row.pr_rowstamp,
        contract_rowstamp: row.contract_rowstamp,
        last_changed_at: row.last_changed_at,
        last_seen_at: row.last_seen_at,
      })),
      lines: deriveContractLines(
        current.raw,
        current.contractnum,
        current.revisionnum,
      ),
      statusHistory: deriveContractStatusHistory(
        current.raw,
        current.contractnum,
        current.revisionnum,
      ),
      prStatusHistory,
    };
  }

  /**
   * K3: historial PRSTATUS de la PR, una vez por PR (lo escriben staging y
   * remap), en el orden de `seq` (CHANGEDATE, desempate PRSTATUSID). Sin
   * prnum (contrato directo) no hay PR: lista vacía.
   */
  private async prStatusHistory(
    prnum: string | null,
  ): Promise<MaximoPrStatusEntry[]> {
    if (!prnum) return [];
    const rows = await this.prisma.maximo_pr_status_history.findMany({
      where: { prnum },
      orderBy: { seq: 'asc' },
      select: { status: true, change_date: true, changed_by: true, memo: true },
    });
    const names = await this.aliases.resolveMany(
      'maximo',
      rows.map((r) => r.changed_by),
    );
    return rows.map((r) => ({
      status: r.status,
      changedAt: r.change_date,
      changedBy: r.changed_by,
      changedByName: r.changed_by ? (names.get(r.changed_by) ?? null) : null,
      memo: r.memo,
    }));
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  async getSummary(year: number | null = null): Promise<MaximoSummary> {
    const inYear = andYear('created_at_source', year);
    const [
      poByStatus,
      contractGroups,
      requestsByStatus,
      lastPoRun,
      lastContractRun,
    ] = await Promise.all([
      this.prisma.$queryRaw<MaximoStatusCount[]>(Prisma.sql`
          WITH current AS (${CURRENT_MAXIMO_POS})
          SELECT status, count(*)::int AS count FROM current
          WHERE true ${inYear}
          GROUP BY status ORDER BY count DESC`),
      this.prisma.$queryRaw<
        Array<{ status: string | null; has_contract: boolean; count: number }>
      >(Prisma.sql`
          WITH current AS (${CURRENT_MAXIMO_CONTRACTS})
          SELECT status, has_contract, count(*)::int AS count FROM current
          WHERE true ${inYear}
          GROUP BY status, has_contract ORDER BY count DESC`),
      // K4.4: solicitudes por el estatus DE LA PR, una por PR; con año,
      // por su creación (ISSUEDATE)
      this.prisma.$queryRaw<MaximoStatusCount[]>(Prisma.sql`
          WITH prs AS (${CURRENT_MAXIMO_PRS})
          SELECT p.pr_status AS status, count(DISTINCT p.prnum)::int AS count
          FROM prs p
          WHERE true ${andYear('p.pr_issue_date', year)}
          GROUP BY p.pr_status ORDER BY count DESC`),
      this.findLastRun('purchase_orders'),
      this.findLastRun('contracts'),
    ]);

    const contractByStatus = new Map<string | null, number>();
    let contractTotal = 0;
    let withContract = 0;
    for (const group of contractGroups) {
      contractTotal += group.count;
      if (group.has_contract) withContract += group.count;
      contractByStatus.set(
        group.status,
        (contractByStatus.get(group.status) ?? 0) + group.count,
      );
    }

    return {
      syncEnabled: this.isSyncEnabled(),
      year,
      purchaseOrders: {
        total: poByStatus.reduce((sum, s) => sum + s.count, 0),
        byStatus: poByStatus,
      },
      contracts: {
        total: contractTotal,
        withContract,
        byStatus: [...contractByStatus.entries()]
          .map(([status, count]) => ({ status, count }))
          .sort((a, b) => b.count - a.count),
      },
      requests: {
        total: requestsByStatus.reduce((sum, s) => sum + s.count, 0),
        byStatus: requestsByStatus,
      },
      lastSync: { purchase_orders: lastPoRun, contracts: lastContractRun },
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private isSyncEnabled(): boolean {
    const value = this.config.get<boolean | string>('MAXIMO_SYNC_ENABLED');
    return (
      value === true || (typeof value === 'string' && value.trim() === 'true')
    );
  }

  private async findLastRun(
    target: 'purchase_orders' | 'contracts',
  ): Promise<MaximoLastSyncRun | null> {
    const run = await this.prisma.maximo_sync_runs.findFirst({
      where: { target },
      orderBy: { started_at: 'desc' },
      select: {
        status: true,
        triggered_by: true,
        started_at: true,
        finished_at: true,
        records_inserted: true,
        records_updated: true,
        records_remapped: true,
        records_unchanged: true,
        records_failed: true,
      },
    });
    return run ?? null;
  }

  /** Alias (D6/E4/F1) + proveedor efectivo (G1) de las OC. */
  private async enrichPos(
    rows: MaximoPurchaseOrderView[],
  ): Promise<MaximoPurchaseOrderView[]> {
    const [named, resolved] = await Promise.all([
      this.withPoAliases(rows),
      this.vendors.resolve(rows),
    ]);
    return named.map((row, i) => ({
      ...row,
      ...supplierFields(resolved[i].supplier),
    }));
  }

  /** Alias (D6) + proveedor efectivo por cruce de código (G1) de contratos. */
  private async enrichContracts(
    rows: MaximoContractView[],
  ): Promise<MaximoContractView[]> {
    const [named, resolved] = await Promise.all([
      this.withContractAliases(rows),
      // Los contratos no migran a SAP: solo aplica el cruce por código (b)
      this.vendors.resolve(
        rows.map((r) => ({
          vendor_id: r.vendor_id,
          vendor_name: r.vendor_name,
        })),
      ),
    ]);
    return named.map((row, i) => ({
      ...row,
      ...supplierFields(resolved[i].supplier),
    }));
  }

  /** D6: nombres de solicitante/aprobador según los alias de Maximo. */
  private async withPoAliases(
    rows: MaximoPurchaseOrderView[],
  ): Promise<MaximoPurchaseOrderView[]> {
    const names = await this.aliases.resolveMany(
      'maximo',
      rows.flatMap((r) => [
        r.requested_by,
        r.approved_by,
        r.purchase_agent,
        r.created_by,
      ]),
    );
    return rows.map((r) => ({
      ...r,
      requested_by_name: r.requested_by
        ? (names.get(r.requested_by) ?? null)
        : null,
      approved_by_name: r.approved_by
        ? (names.get(r.approved_by) ?? null)
        : null,
      ...buyerFields(maximoBuyer(r, names)),
    }));
  }

  private async withContractAliases(
    rows: MaximoContractView[],
  ): Promise<MaximoContractView[]> {
    const names = await this.aliases.resolveMany(
      'maximo',
      rows.flatMap((r) => [r.requested_by, r.approved_by]),
    );
    return rows.map((r) => ({
      ...r,
      requested_by_name: r.requested_by
        ? (names.get(r.requested_by) ?? null)
        : null,
      approved_by_name: r.approved_by
        ? (names.get(r.approved_by) ?? null)
        : null,
    }));
  }

  private mapPoRow(row: PoSqlRow): MaximoPurchaseOrderView {
    return {
      id: row.id,
      ponum: row.ponum,
      siteid: row.siteid,
      revisionnum: row.revisionnum,
      status: row.status,
      description: row.description,
      vendor_id: row.vendor_id,
      vendor_name: row.vendor_name,
      total_cost: toNumber(row.total_cost),
      currency: row.currency,
      ab_ahorro: toNumber(row.ab_ahorro),
      ab_tipocomp: row.ab_tipocomp,
      ab_clasfpo: row.ab_clasfpo,
      requested_by: row.requested_by,
      requested_by_name: null,
      purchase_agent: row.purchase_agent ?? null,
      purchase_agent_name: row.purchase_agent_name ?? null,
      created_by: row.created_by ?? null,
      buyer_kind: null,
      buyer_name: null,
      department: row.department,
      approved_at: row.approved_at,
      approved_by: row.approved_by,
      approved_by_name: null,
      waiting_approval_at: row.waiting_approval_at,
      created_at_source: row.created_at_source,
      last_changed_at: row.last_changed_at,
      last_seen_at: row.last_seen_at,
      ...NO_SUPPLIER,
    };
  }

  private mapContractRow(row: ContractSqlRow): MaximoContractView {
    const contractValue = toNumber(row.contract_value);
    const consumed = toNumber(row.consumed_value);
    return {
      id: row.id,
      prnum: row.prnum,
      contractnum: row.contractnum,
      revisionnum: row.revisionnum,
      status: row.status,
      maxvol: toNumber(row.maxvol),
      total_cost: toNumber(row.total_cost),
      currency: row.currency,
      start_date: row.start_date,
      end_date: row.end_date,
      vendor_id: row.vendor_id,
      vendor_name: row.vendor_name,
      requested_by: row.requested_by,
      requested_by_name: null,
      department: row.department,
      approved_at: row.approved_at,
      approved_by: row.approved_by,
      approved_by_name: null,
      created_at_source: row.created_at_source,
      // K3/K4: estatus y fechas de la PR (en el detalle llegan de Prisma)
      pr_status: row.pr_status ?? null,
      pr_issue_date: row.pr_issue_date ?? null,
      pr_approved_at: row.pr_approved_at ?? null,
      pr_status_date: row.pr_status_date ?? null,
      contract_ref_num: row.contract_ref_num,
      contract_value: contractValue,
      pr_total: toNumber(row.pr_total),
      consumed_value: consumed,
      // D8: saldo = valor − consumido; null si falta alguno (nunca 0)
      balance_value:
        contractValue === null || consumed === null
          ? null
          : Math.round((contractValue - consumed) * 100) / 100,
      purchview_count: row.purchview_count,
      has_po: row.has_po === true,
      has_contract: row.has_contract,
      last_changed_at: row.last_changed_at,
      last_seen_at: row.last_seen_at,
      ...NO_SUPPLIER,
    };
  }
}
