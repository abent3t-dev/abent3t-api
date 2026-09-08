import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaginatedResponse } from '../common/interfaces/paginated-response.interface';
import {
  deriveContractLines,
  deriveContractStatusHistory,
} from './maximo-contract-raw';
import { MaximoContractQueryDto } from './dto/maximo-contract-query.dto';
import { MaximoPoQueryDto } from './dto/maximo-po-query.dto';
import {
  MaximoContractDetail,
  MaximoContractView,
  MaximoLastSyncRun,
  MaximoPurchaseOrderDetail,
  MaximoPurchaseOrderView,
  MaximoStatusCount,
  MaximoSummary,
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
 */

/** Vista actual de POs: mayor revisionnum por (ponum, siteid). */
const CURRENT_POS = Prisma.sql`
  SELECT DISTINCT ON (ponum, coalesce(siteid, '')) *
  FROM maximo_purchase_orders
  ORDER BY ponum, coalesce(siteid, ''), coalesce(revisionnum, 0) DESC`;

/** Vista actual de contratos: mayor revisionnum por (prnum, contractnum). */
const CURRENT_CONTRACTS = Prisma.sql`
  SELECT DISTINCT ON (coalesce(prnum, ''), coalesce(contractnum, '')) *
  FROM maximo_contracts
  ORDER BY coalesce(prnum, ''), coalesce(contractnum, ''),
    coalesce(revisionnum, 0) DESC`;

/** Columnas del listado de POs (excluye `raw`: solo viaja en el detalle). */
const PO_LIST_COLUMNS = Prisma.sql`
  id, ponum, siteid, revisionnum, status, description, vendor_id, vendor_name,
  total_cost, currency, ab_ahorro, ab_tipocomp, ab_clasfpo, requested_by,
  department, approved_at, created_at_source, last_changed_at, last_seen_at`;

const CONTRACT_LIST_COLUMNS = Prisma.sql`
  id, prnum, contractnum, revisionnum, status, maxvol, total_cost, currency,
  start_date, end_date, vendor_id, vendor_name, requested_by, department,
  approved_at, created_at_source, contract_ref_num, contract_value,
  purchview_count, has_contract, last_changed_at, last_seen_at`;

/** Filas crudas del driver: numerics llegan como Prisma.Decimal. */
type PoSqlRow = Omit<
  MaximoPurchaseOrderView,
  'total_cost' | 'ab_ahorro' | 'raw'
> & { total_cost: unknown; ab_ahorro: unknown };

type ContractSqlRow = Omit<
  MaximoContractView,
  'maxvol' | 'total_cost' | 'contract_value' | 'raw'
> & { maxvol: unknown; total_cost: unknown; contract_value: unknown };

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
  ) {}

  // ── Purchase orders ─────────────────────────────────────────────────────

  async listPurchaseOrders(
    query: MaximoPoQueryDto,
  ): Promise<PaginatedResponse<MaximoPurchaseOrderView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const conditions: Prisma.Sql[] = [];
    if (query.status) conditions.push(Prisma.sql`c.status = ${query.status}`);
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
    const where = conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;

    const [rows, counts] = await Promise.all([
      this.prisma.$queryRaw<PoSqlRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_POS})
        SELECT ${PO_LIST_COLUMNS}
        FROM current c
        ${where}
        ORDER BY c.approved_at DESC NULLS LAST, c.ponum ASC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        WITH current AS (${CURRENT_POS})
        SELECT count(*)::int AS count FROM current c ${where}`),
    ]);

    return {
      data: rows.map((row) => this.mapPoRow(row)),
      meta: buildMeta(counts[0]?.count ?? 0, page, limit),
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
    return {
      current: {
        ...this.mapPoRow(current),
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

  async listContracts(
    query: MaximoContractQueryDto,
  ): Promise<PaginatedResponse<MaximoContractView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const conditions: Prisma.Sql[] = [];
    if (query.status) conditions.push(Prisma.sql`c.status = ${query.status}`);
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
    const where = conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;

    const [rows, counts] = await Promise.all([
      this.prisma.$queryRaw<ContractSqlRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_CONTRACTS})
        SELECT ${CONTRACT_LIST_COLUMNS}
        FROM current c
        ${where}
        ORDER BY c.end_date DESC NULLS LAST,
          coalesce(c.prnum, '') ASC, coalesce(c.contractnum, '') ASC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        WITH current AS (${CURRENT_CONTRACTS})
        SELECT count(*)::int AS count FROM current c ${where}`),
    ]);

    return {
      data: rows.map((row) => this.mapContractRow(row)),
      meta: buildMeta(counts[0]?.count ?? 0, page, limit),
    };
  }

  /**
   * Detalle por clave: `key` es el prnum, o el contractnum para las filas de
   * contrato directo que no traen PR (existen en Maximo real y en el seed) —
   * la ruta del doc era `/:prnum`, pero con prnum null serían inalcanzables.
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
    if (rows.length === 0) {
      throw new NotFoundException(
        `Contrato/PR ${key} no existe en staging Maximo`,
      );
    }
    const sorted = [...rows].sort(
      (a, b) => (b.revisionnum ?? -1) - (a.revisionnum ?? -1),
    );
    const current = sorted[0];
    return {
      current: {
        ...this.mapContractRow(current),
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
    };
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  async getSummary(): Promise<MaximoSummary> {
    const [poByStatus, contractGroups, lastPoRun, lastContractRun] =
      await Promise.all([
        this.prisma.$queryRaw<MaximoStatusCount[]>(Prisma.sql`
          WITH current AS (${CURRENT_POS})
          SELECT status, count(*)::int AS count FROM current
          GROUP BY status ORDER BY count DESC`),
        this.prisma.$queryRaw<
          Array<{ status: string | null; has_contract: boolean; count: number }>
        >(Prisma.sql`
          WITH current AS (${CURRENT_CONTRACTS})
          SELECT status, has_contract, count(*)::int AS count FROM current
          GROUP BY status, has_contract ORDER BY count DESC`),
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
        records_unchanged: true,
        records_failed: true,
      },
    });
    return run ?? null;
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
      department: row.department,
      approved_at: row.approved_at,
      created_at_source: row.created_at_source,
      last_changed_at: row.last_changed_at,
      last_seen_at: row.last_seen_at,
    };
  }

  private mapContractRow(row: ContractSqlRow): MaximoContractView {
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
      department: row.department,
      approved_at: row.approved_at,
      created_at_source: row.created_at_source,
      contract_ref_num: row.contract_ref_num,
      contract_value: toNumber(row.contract_value),
      purchview_count: row.purchview_count,
      has_contract: row.has_contract,
      last_changed_at: row.last_changed_at,
      last_seen_at: row.last_seen_at,
    };
  }
}
