import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  deriveContractLines,
  deriveContractStatusHistory,
  findContractRecord,
} from './maximo-contract-raw';
import { MaximoRecordsService } from './maximo-records.service';

/**
 * Fase INT-5. Service probado con Prisma MOCKEADO — cero red, cero BD.
 * Los raw de contratos son copias inline sanitizadas con la MISMA forma que
 * persiste el sync de Int-3 (PR con PURCHVIEW anidado y registro de contrato
 * directo); no se leen fixtures de otras carpetas para que este módulo no
 * referencie la capa de integración ni por ruta (criterio por grep).
 */

/** Forma 1: registro PR legacy-compacto con PURCHVIEW anidado. */
const RAW_PR_WITH_PURCHVIEW = {
  PRNUM: 'PR102828',
  SITEID: 'A3T',
  rowstamp: '100',
  PURCHVIEW: [
    {
      CONTRACTNUM: '1091',
      REVISIONNUM: 0,
      rowstamp: '200',
      CONTRACTLINE: [
        { CONTRACTLINENUM: 1, ITEMNUM: 'ITEM-A', DESCRIPTION: 'Refacción A' },
        { CONTRACTLINENUM: 2, ITEMNUM: 'ITEM-B', DESCRIPTION: 'Refacción B' },
      ],
      CONTRACTSTATUS: [
        { STATUS: 'APPR', CHANGEDATE: '2026-06-05T10:00:00+00:00' },
        { STATUS: 'PNDREV', CHANGEDATE: '2026-06-04T09:00:00+00:00' },
      ],
    },
  ],
};

/** Forma 2: registro de contrato directo en la raíz (sin PR). */
const RAW_CONTRACT_DIRECT = {
  CONTRACTNUM: '1040',
  REVISIONNUM: 1,
  rowstamp: '300',
  CONTRACTLINE: [
    { CONTRACTLINENUM: 1, ITEMNUM: 'TST1ACIDO', ITEM: [{ ITEMNUM: 'X' }] },
  ],
  CONTRACTSTATUS: [
    { STATUS: 'WAPPR', CHANGEDATE: '2024-08-29T11:03:09+00:00' },
    { STATUS: 'PNDREV', CHANGEDATE: '2024-08-29T11:00:46+00:00' },
  ],
};

interface FakePrismaShape {
  $queryRaw: jest.Mock;
  maximo_purchase_orders: { findMany: jest.Mock };
  maximo_contracts: { findMany: jest.Mock };
  maximo_sync_runs: { findFirst: jest.Mock };
}

function makeService(env: Record<string, string> = {}) {
  const prisma: FakePrismaShape = {
    $queryRaw: jest.fn(),
    maximo_purchase_orders: { findMany: jest.fn().mockResolvedValue([]) },
    maximo_contracts: { findMany: jest.fn().mockResolvedValue([]) },
    maximo_sync_runs: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const config = { get: (key: string) => env[key] } as ConfigService;
  const service = new MaximoRecordsService(
    prisma as unknown as PrismaService,
    config,
  );
  return { service, prisma };
}

const poRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'po-1',
  ponum: 'PO102249',
  siteid: 'A3T',
  revisionnum: 0,
  status: 'APPR',
  description: null,
  vendor_id: 'V1',
  vendor_name: 'FLUIDS TECH SA DE CV',
  total_cost: '426978.60', // el driver entrega Decimal; string basta para Number()
  currency: 'USD',
  ab_ahorro: '27645.00',
  ab_tipocomp: 'CL',
  ab_clasfpo: 'CAPEX',
  requested_by: null,
  department: 'A3T',
  approved_at: null,
  created_at_source: null,
  rowstamp: '900',
  raw: { PONUM: 'PO102249' },
  last_changed_at: null,
  last_seen_at: new Date('2026-08-31T00:00:00Z'),
  ...overrides,
});

describe('MaximoRecordsService', () => {
  describe('listPurchaseOrders', () => {
    it('mapea Decimal→number y arma la meta estándar de paginación', async () => {
      const { service, prisma } = makeService();
      prisma.$queryRaw
        .mockResolvedValueOnce([poRow()])
        .mockResolvedValueOnce([{ count: 41 }]);

      const result = await service.listPurchaseOrders({ page: 2, limit: 20 });
      expect(result.data).toHaveLength(1);
      expect(result.data[0].total_cost).toBe(426978.6);
      expect(result.data[0].ab_ahorro).toBe(27645);
      expect(result.data[0].description).toBeNull();
      // El listado nunca incluye el raw
      expect('raw' in result.data[0]).toBe(false);
      expect(result.meta).toEqual({
        total: 41,
        page: 2,
        limit: 20,
        totalPages: 3,
        hasNext: true,
        hasPrev: true,
      });
    });

    it('con staging vacío devuelve data=[] y totalPages=1', async () => {
      const { service, prisma } = makeService();
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);
      const result = await service.listPurchaseOrders({});
      expect(result.data).toEqual([]);
      expect(result.meta.totalPages).toBe(1);
      expect(result.meta.hasNext).toBe(false);
    });
  });

  describe('getPurchaseOrder', () => {
    it('la revisión actual es la mayor; lista todas; raw solo para admins', async () => {
      const { service, prisma } = makeService();
      const rows = [
        poRow({ id: 'po-r0', revisionnum: 0, status: 'APPR' }),
        poRow({ id: 'po-r2', revisionnum: 2, status: 'CLOSE' }),
        poRow({ id: 'po-r1', revisionnum: 1, status: 'REVISD' }),
      ];
      prisma.maximo_purchase_orders.findMany.mockResolvedValue(rows);

      const asViewer = await service.getPurchaseOrder('PO102249', false);
      expect(asViewer.current.revisionnum).toBe(2);
      expect(asViewer.current.status).toBe('CLOSE');
      expect('raw' in asViewer.current).toBe(false);
      expect(asViewer.revisions.map((r) => r.revisionnum)).toEqual([2, 1, 0]);

      const asAdmin = await service.getPurchaseOrder('PO102249', true);
      expect(asAdmin.current.raw).toEqual({ PONUM: 'PO102249' });
    });

    it('PO inexistente → NotFoundException', async () => {
      const { service } = makeService();
      await expect(service.getPurchaseOrder('NOPE', false)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getContract', () => {
    const contractRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'ct-1',
      prnum: 'PR102828',
      contractnum: '1091',
      revisionnum: 0,
      status: 'APPR',
      maxvol: null,
      total_cost: '1000.00',
      currency: 'MXN',
      start_date: null,
      end_date: null,
      vendor_id: null,
      vendor_name: 'Graco Mexicana S.A. de C.V.',
      requested_by: null,
      department: 'TI',
      approved_at: null,
      created_at_source: null,
      contract_ref_num: null,
      contract_value: null,
      purchview_count: 1,
      has_contract: true,
      pr_rowstamp: '100',
      contract_rowstamp: '200',
      raw: RAW_PR_WITH_PURCHVIEW,
      last_changed_at: null,
      last_seen_at: new Date('2026-08-31T00:00:00Z'),
      ...overrides,
    });

    it('deriva líneas e historial (ordenado por fecha) del raw con PURCHVIEW', async () => {
      const { service, prisma } = makeService();
      prisma.maximo_contracts.findMany.mockResolvedValue([contractRow()]);

      const detail = await service.getContract('PR102828', false);
      expect(detail.current.contractnum).toBe('1091');
      expect(detail.lines).toEqual([
        {
          lineNum: 1,
          itemNum: 'ITEM-A',
          description: 'Refacción A',
          quantity: null,
          unitCost: null,
        },
        {
          lineNum: 2,
          itemNum: 'ITEM-B',
          description: 'Refacción B',
          quantity: null,
          unitCost: null,
        },
      ]);
      expect(detail.statusHistory.map((s) => s.status)).toEqual([
        'PNDREV',
        'APPR',
      ]);
      expect('raw' in detail.current).toBe(false);
    });

    it('contrato sin PR (prnum null) se resuelve por contractnum; actual = mayor revisión', async () => {
      const { service, prisma } = makeService();
      prisma.maximo_contracts.findMany.mockResolvedValue([
        contractRow({
          id: 'ct-r0',
          prnum: null,
          contractnum: '1040',
          revisionnum: 0,
          status: 'APPR',
          raw: { ...RAW_CONTRACT_DIRECT, REVISIONNUM: 0 },
        }),
        contractRow({
          id: 'ct-r1',
          prnum: null,
          contractnum: '1040',
          revisionnum: 1,
          status: 'WAPPR',
          raw: RAW_CONTRACT_DIRECT,
        }),
      ]);

      const detail = await service.getContract('1040', true);
      expect(detail.current.revisionnum).toBe(1);
      expect(detail.current.status).toBe('WAPPR');
      expect(detail.revisions).toHaveLength(2);
      expect(detail.lines[0].itemNum).toBe('TST1ACIDO');
      expect(detail.current.raw).toEqual(RAW_CONTRACT_DIRECT);
    });

    it('PR sin contrato: has_contract=false, líneas e historial vacíos', async () => {
      const { service, prisma } = makeService();
      prisma.maximo_contracts.findMany.mockResolvedValue([
        contractRow({
          prnum: 'PR100026',
          contractnum: null,
          revisionnum: null,
          status: null,
          has_contract: false,
          purchview_count: 0,
          raw: { rowstamp: '1', Attributes: {}, RelatedMbos: {} },
        }),
      ]);
      const detail = await service.getContract('PR100026', false);
      expect(detail.current.has_contract).toBe(false);
      expect(detail.lines).toEqual([]);
      expect(detail.statusHistory).toEqual([]);
    });
  });

  describe('getSummary', () => {
    it('agrega por estatus, calcula withContract y refleja el flag del env', async () => {
      const { service, prisma } = makeService({ MAXIMO_SYNC_ENABLED: 'true' });
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { status: 'CLOSE', count: 4 },
          { status: null, count: 3 },
        ])
        .mockResolvedValueOnce([
          { status: 'APPR', has_contract: true, count: 2 },
          { status: null, has_contract: false, count: 2 },
          { status: 'WAPPR', has_contract: true, count: 1 },
        ]);
      prisma.maximo_sync_runs.findFirst
        .mockResolvedValueOnce({
          status: 'success',
          triggered_by: 'seed',
          started_at: new Date('2026-08-31T00:00:00Z'),
          finished_at: new Date('2026-08-31T00:00:05Z'),
          records_inserted: 7,
          records_updated: 0,
          records_unchanged: 0,
          records_failed: 0,
        })
        .mockResolvedValueOnce(null);

      const summary = await service.getSummary();
      expect(summary.syncEnabled).toBe(true);
      expect(summary.purchaseOrders.total).toBe(7);
      expect(summary.contracts.total).toBe(5);
      expect(summary.contracts.withContract).toBe(3);
      expect(summary.contracts.byStatus).toContainEqual({
        status: 'APPR',
        count: 2,
      });
      expect(summary.lastSync.purchase_orders?.records_inserted).toBe(7);
      expect(summary.lastSync.contracts).toBeNull();
    });

    it('sin flag en el env, syncEnabled=false', async () => {
      const { service, prisma } = makeService();
      prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const summary = await service.getSummary();
      expect(summary.syncEnabled).toBe(false);
      expect(summary.purchaseOrders.total).toBe(0);
    });
  });
});

describe('derivación pura del raw de contratos', () => {
  it('con varios PURCHVIEW elige la revisión por (contractnum, revisionnum)', () => {
    const raw = {
      PRNUM: 'PRX',
      PURCHVIEW: [
        { CONTRACTNUM: '1091', REVISIONNUM: 0, CONTRACTLINE: [] },
        {
          CONTRACTNUM: '1091',
          REVISIONNUM: 1,
          CONTRACTLINE: [{ CONTRACTLINENUM: 9, ITEMNUM: 'Z' }],
        },
      ],
    };
    const record = findContractRecord(raw, '1091', 1);
    expect(record?.REVISIONNUM).toBe(1);
    expect(deriveContractLines(raw, '1091', 1)[0].lineNum).toBe(9);
    expect(deriveContractLines(raw, '1091', 99)).toEqual([]);
  });

  it('formas inesperadas devuelven vacío sin lanzar', () => {
    for (const raw of [null, 42, 'x', [], { PURCHVIEW: 'no-array' }]) {
      expect(deriveContractLines(raw, '1', 0)).toEqual([]);
      expect(deriveContractStatusHistory(raw, '1', 0)).toEqual([]);
    }
  });
});
