import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { buildExcel } from '../common/utils/excel-export.util';
import {
  MAXIMO_PR_STATUS_LABELS,
  maximoPrStatusLabel,
  maximoPrStatusWithCode,
  maximoStatusWithCode,
} from '../common/utils/maximo-status.util';
import {
  deriveContractLines,
  deriveContractStatusHistory,
  findContractRecord,
} from './maximo-contract-raw';
import { derivePurchaseOrderLines } from './maximo-po-raw';
import { toContracts } from '../integrations/maximo/maximo.mapper';
import {
  CONTRACT_COLUMNS,
  PO_COLUMNS,
  REQUEST_COLUMNS,
} from './maximo-records.controller';
import { MaximoRecordsService } from './maximo-records.service';
import type {
  MaximoContractView,
  MaximoPurchaseOrderView,
} from './maximo-records.types';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import {
  buildVendorXref,
  effectiveMaximoVendor,
  MaximoVendorXref,
} from '../erp-vendors/maximo-vendor-xref';

/**
 * Fase INT-5. Service probado con Prisma MOCKEADO — cero red, cero BD.
 * Los raw de contratos son copias inline sanitizadas con la MISMA forma que
 * persiste el sync de Int-3 (PR con PURCHVIEW anidado y registro de contrato
 * directo; K3.7: también el legacy ANIDADO de prod, Attributes/RelatedMbos);
 * no se leen fixtures de otras carpetas para que este módulo no referencie
 * la capa de integración ni por ruta (criterio por grep).
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

/** Escalar en la forma legacy anidada (`{ content }`). */
const c = (content: unknown) => ({ content });

/**
 * K3.7: forma legacy ANIDADA (`Attributes`/`RelatedMbos`), la que guarda prod
 * porque el listado no pide `_compact`. PR con dos revisiones del contrato en
 * PURCHVIEW (líneas e historial desordenado anidados) y su PRSTATUS, que el
 * detalle NO lee del raw (sale de maximo_pr_status_history). Valores dummy.
 */
const RAW_PR_NESTED = {
  rowstamp: '990100006',
  Attributes: {
    PRNUM: c('PR990006'),
    SITEID: c('A3T'),
    STATUS: c('CLOSE'),
  },
  RelatedMbos: {
    PRSTATUS: [
      {
        rowstamp: '990100061',
        Attributes: {
          STATUS: c('WAPPR'),
          CHANGEDATE: c('2026-06-10T09:00:00+00:00'),
          CHANGEBY: c('USR031'),
          PRSTATUSID: { content: 990061, resourceid: true },
        },
      },
    ],
    PURCHVIEW: [
      {
        rowstamp: '990160000',
        Attributes: { CONTRACTNUM: c('9906'), REVISIONNUM: c(0) },
        RelatedMbos: {
          CONTRACTLINE: [
            {
              rowstamp: '990160701',
              Attributes: {
                CONTRACTLINENUM: c(1),
                ITEMNUM: c('9990001'),
                DESCRIPTION: c('Servicio demo mensual'),
              },
            },
          ],
          CONTRACTSTATUS: [
            {
              rowstamp: '990160604',
              Attributes: {
                STATUS: c('REVISD'),
                CHANGEDATE: c('2026-08-01T09:00:00+00:00'),
              },
            },
          ],
        },
      },
      {
        rowstamp: '990160001',
        Attributes: { CONTRACTNUM: c('9906'), REVISIONNUM: c(1) },
        RelatedMbos: {
          CONTRACTLINE: [
            {
              rowstamp: '990160701',
              Attributes: {
                CONTRACTLINENUM: c(1),
                ITEMNUM: c('9990001'),
                DESCRIPTION: c('Servicio demo mensual'),
                ORDERQTY: c(12),
                UNITCOST: c(8000),
              },
            },
            {
              rowstamp: '990160702',
              Attributes: {
                CONTRACTLINENUM: c(2),
                ITEMNUM: c('9990002'),
                DESCRIPTION: c('~null~'),
              },
            },
          ],
          CONTRACTSTATUS: [
            {
              rowstamp: '990160605',
              Attributes: {
                STATUS: c('APPR'),
                CHANGEDATE: c('2026-08-02T11:00:00+00:00'),
                CONTRACTSTATUSID: { content: 990605, resourceid: true },
              },
            },
            {
              rowstamp: '990160603',
              Attributes: {
                STATUS: c('PNDREV'),
                CHANGEDATE: c('2026-08-01T09:00:00+00:00'),
                CONTRACTSTATUSID: { content: 990603, resourceid: true },
              },
            },
          ],
        },
      },
    ],
  },
};

/** Lo que el detalle debe derivar de RAW_PR_NESTED para la revisión 1. */
const NESTED_REV1_LINES = [
  {
    lineNum: 1,
    itemNum: '9990001',
    description: 'Servicio demo mensual',
    quantity: 12,
    unitCost: 8000,
  },
  {
    lineNum: 2,
    itemNum: '9990002',
    description: null,
    quantity: null,
    unitCost: null,
  },
];
const NESTED_REV1_HISTORY = [
  { status: 'PNDREV', changedAt: '2026-08-01T09:00:00+00:00' },
  { status: 'APPR', changedAt: '2026-08-02T11:00:00+00:00' },
];

interface FakePrismaShape {
  $queryRaw: jest.Mock;
  maximo_purchase_orders: { findMany: jest.Mock };
  maximo_contracts: { findMany: jest.Mock };
  maximo_pr_status_history: { findMany: jest.Mock };
  maximo_sync_runs: { findFirst: jest.Mock };
  sap_purchase_orders: { aggregate: jest.Mock };
}

/** G1: cruce de proveedores de prueba (por defecto, vacío = según Maximo). */
function makeVendors(xref: MaximoVendorXref = buildVendorXref([], new Map())) {
  return {
    resolve: jest.fn(
      (
        rows: Array<{
          vendor_id: string | null;
          vendor_name: string | null;
          ponum?: string | null;
        }>,
      ) =>
        Promise.resolve(
          rows.map((row) => ({
            ...row,
            supplier: effectiveMaximoVendor(row, xref),
          })),
        ),
    ),
  };
}

function makeService(
  env: Record<string, string> = {},
  xref?: MaximoVendorXref,
) {
  const prisma: FakePrismaShape = {
    $queryRaw: jest.fn(),
    maximo_purchase_orders: { findMany: jest.fn().mockResolvedValue([]) },
    maximo_contracts: { findMany: jest.fn().mockResolvedValue([]) },
    maximo_pr_status_history: { findMany: jest.fn().mockResolvedValue([]) },
    maximo_sync_runs: { findFirst: jest.fn().mockResolvedValue(null) },
    // K7.1: OC de SAP del detalle (min(DocNum) de sus copias); sin copias
    sap_purchase_orders: {
      aggregate: jest.fn().mockResolvedValue({ _min: { doc_num: null } }),
    },
  };
  const config = { get: (key: string) => env[key] } as ConfigService;
  const aliases = {
    resolveMany: jest.fn().mockResolvedValue(new Map<string, string>()),
    displayName: jest.fn((_s: string, code: string | null) =>
      Promise.resolve(code),
    ),
    forProfiles: jest.fn().mockResolvedValue([]),
    byCode: jest.fn().mockResolvedValue(new Map()),
  };
  const vendors = makeVendors(xref);
  const service = new MaximoRecordsService(
    prisma as unknown as PrismaService,
    config,
    aliases as unknown as ErpAliasesService,
    vendors as unknown as MaximoVendorXrefService,
  );
  return { service, prisma, aliases, vendors };
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
      // K3: sin prnum no hay PR ni historial de la PR (y no se consulta)
      expect(detail.prStatusHistory).toEqual([]);
      expect(prisma.maximo_pr_status_history.findMany).not.toHaveBeenCalled();
    });

    it('K3.7: con el raw ANIDADO de prod muestra líneas e historial del contrato', async () => {
      const { service, prisma } = makeService();
      prisma.maximo_contracts.findMany.mockResolvedValue([
        contractRow({
          id: 'ct-r0',
          prnum: 'PR990006',
          contractnum: '9906',
          revisionnum: 0,
          status: 'REVISD',
          raw: RAW_PR_NESTED,
        }),
        contractRow({
          id: 'ct-r1',
          prnum: 'PR990006',
          contractnum: '9906',
          revisionnum: 1,
          status: 'APPR',
          raw: RAW_PR_NESTED,
        }),
      ]);

      const detail = await service.getContract('PR990006', false);
      expect(detail.current.revisionnum).toBe(1);
      // antes de K3.7 salían vacíos: findContractRecord solo leía el compacto
      expect(detail.lines).toEqual(NESTED_REV1_LINES);
      expect(detail.statusHistory).toEqual(NESTED_REV1_HISTORY);
    });

    it('K8: current = la revisión más alta NO superseded; las obsoletas no se listan', async () => {
      const { service, prisma } = makeService();
      const superseded = new Date('2026-10-05T12:00:00Z');
      prisma.maximo_contracts.findMany.mockResolvedValue([
        // fila vieja sin contrato de la PR que después tuvo contrato
        contractRow({
          id: 'ct-old',
          prnum: 'PR990006',
          contractnum: null,
          revisionnum: null,
          status: 'APPR',
          has_contract: false,
          superseded_at: superseded,
          raw: { rowstamp: '1', Attributes: {}, RelatedMbos: {} },
        }),
        contractRow({
          id: 'ct-r0',
          prnum: 'PR990006',
          contractnum: '9906',
          revisionnum: 0,
          status: 'REVISD',
          superseded_at: null,
          raw: RAW_PR_NESTED,
        }),
        // revisión retirada: más alta, pero obsoleta
        contractRow({
          id: 'ct-r2',
          prnum: 'PR990006',
          contractnum: '9906',
          revisionnum: 2,
          status: 'APPR',
          superseded_at: superseded,
          raw: RAW_PR_NESTED,
        }),
      ]);

      const detail = await service.getContract('PR990006', false);
      expect(detail.current.id).toBe('ct-r0');
      expect(detail.current.status).toBe('REVISD');
      expect(detail.revisions.map((r) => r.id)).toEqual(['ct-r0']);
      expect(detail.lines.map((l) => l.itemNum)).toEqual(['9990001']);
      expect(detail.statusHistory.map((s) => s.status)).toEqual(['REVISD']);
    });

    it('K8: si todas las filas de la clave son obsoletas → NotFoundException', async () => {
      const { service, prisma } = makeService();
      prisma.maximo_contracts.findMany.mockResolvedValue([
        contractRow({ superseded_at: new Date('2026-10-05T12:00:00Z') }),
      ]);
      await expect(service.getContract('PR102828', false)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('K3: prStatusHistory sale de maximo_pr_status_history (por seq), con alias y MEMO, no del raw', async () => {
      const { service, prisma, aliases } = makeService();
      prisma.maximo_contracts.findMany.mockResolvedValue([
        contractRow({
          prnum: 'PR990006',
          contractnum: '9906',
          revisionnum: 1,
          raw: RAW_PR_NESTED,
        }),
      ]);
      prisma.maximo_pr_status_history.findMany.mockResolvedValue([
        {
          status: 'WAPPR',
          change_date: new Date('2026-06-10T09:00:00Z'),
          changed_by: 'USR031',
          memo: null,
        },
        {
          status: 'APPR',
          change_date: new Date('2026-06-10T09:00:00Z'),
          changed_by: 'USR032',
          memo: null,
        },
        {
          status: 'CLOSE',
          change_date: new Date('2026-07-01T16:40:00Z'),
          changed_by: 'USR031',
          memo: 'Comentario de prueba',
        },
      ]);
      aliases.resolveMany.mockResolvedValue(
        new Map([['USR032', 'Persona Demo 32']]),
      );

      const detail = await service.getContract('PR990006', false);
      expect(prisma.maximo_pr_status_history.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { prnum: 'PR990006' },
          orderBy: { seq: 'asc' },
        }),
      );
      // el raw solo trae un WAPPR: el historial completo es el de la tabla
      expect(detail.prStatusHistory).toEqual([
        {
          status: 'WAPPR',
          changedAt: new Date('2026-06-10T09:00:00Z'),
          changedBy: 'USR031',
          changedByName: null,
          memo: null,
        },
        {
          status: 'APPR',
          changedAt: new Date('2026-06-10T09:00:00Z'),
          changedBy: 'USR032',
          changedByName: 'Persona Demo 32',
          memo: null,
        },
        {
          status: 'CLOSE',
          changedAt: new Date('2026-07-01T16:40:00Z'),
          changedBy: 'USR031',
          changedByName: null,
          memo: 'Comentario de prueba',
        },
      ]);
      expect(aliases.resolveMany).toHaveBeenCalledWith('maximo', [
        'USR031',
        'USR032',
        'USR031',
      ]);
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
      expect(detail.prStatusHistory).toEqual([]);
    });

    it('K7: current trae el estatus y las fechas DE LA PR (de Prisma), aparte del contrato', async () => {
      const { service, prisma } = makeService();
      prisma.maximo_contracts.findMany.mockResolvedValue([
        contractRow({
          prnum: 'PR990006',
          contractnum: '9906',
          revisionnum: 1,
          status: 'APPR',
          pr_status: 'CLOSE',
          pr_issue_date: new Date('2026-06-10T14:00:00Z'),
          pr_status_date: new Date('2026-07-01T16:40:00Z'),
          pr_approved_at: new Date('2026-06-11T09:00:00Z'),
          raw: RAW_PR_NESTED,
        }),
      ]);
      const detail = await service.getContract('PR990006', false);
      expect(detail.current).toMatchObject({
        status: 'APPR', // el del contrato
        pr_status: 'CLOSE',
        pr_issue_date: new Date('2026-06-10T14:00:00Z'),
        pr_status_date: new Date('2026-07-01T16:40:00Z'),
        pr_approved_at: new Date('2026-06-11T09:00:00Z'),
      });
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
        ])
        // K4.4: solicitudes por el estatus DE LA PR (una por PR)
        .mockResolvedValueOnce([
          { status: 'CLOSE', count: 2 },
          { status: 'APPR', count: 1 },
          { status: 'WAPPR', count: 1 },
        ])
        // H5: contratos distintos (los 3 con contrato son 2 contratos);
        // H8: hay PR con estatus
        .mockResolvedValueOnce([{ contratos: 2, con_estatus: 4 }]);
      prisma.maximo_sync_runs.findFirst
        .mockResolvedValueOnce({
          status: 'success',
          triggered_by: 'seed',
          started_at: new Date('2026-08-31T00:00:00Z'),
          finished_at: new Date('2026-08-31T00:00:05Z'),
          records_inserted: 7,
          records_updated: 0,
          records_remapped: 0,
          records_unchanged: 0,
          records_failed: 0,
        })
        .mockResolvedValueOnce(null);

      const summary = await service.getSummary();
      expect(summary.syncEnabled).toBe(true);
      expect(summary.purchaseOrders.total).toBe(7);
      expect(summary.contracts.total).toBe(5);
      expect(summary.contracts.withContract).toBe(3);
      expect(summary.contracts.distinct).toBe(2);
      expect(summary.contracts.byStatus).toContainEqual({
        status: 'APPR',
        count: 2,
      });
      // K4.4: `contracts` se queda; `requests` va por PR y su estatus
      expect(summary.requests).toEqual({
        total: 4,
        byStatus: [
          { status: 'CLOSE', count: 2 },
          { status: 'APPR', count: 1 },
          { status: 'WAPPR', count: 1 },
        ],
      });
      expect(summary.lastSync.purchase_orders?.records_inserted).toBe(7);
      expect(summary.lastSync.contracts).toBeNull();
    });

    it('K4.4: requests sale de la vista por PR (sin obsoletas) y el año va por ISSUEDATE', async () => {
      const { service, prisma } = makeService();
      prisma.$queryRaw.mockResolvedValue([]);
      // H8: con PR con estatus, un año sin PR es 0 (dato)
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ contratos: 0, con_estatus: 3 }]);
      const summary = await service.getSummary(2026);
      expect(summary.requests).toEqual({ total: 0, byStatus: [] });
      const calls = prisma.$queryRaw.mock.calls as Array<
        [{ sql: string; values: unknown[] }]
      >;
      expect(calls).toHaveLength(4);
      const [requests] = calls[2];
      const text = requests.sql.replace(/\s+/g, ' ');
      expect(text).toContain('DISTINCT ON (prnum)');
      expect(text).toContain('superseded_at IS NULL');
      expect(text).toContain('p.pr_status AS status');
      expect(text).toContain('count(DISTINCT p.prnum)');
      expect(text).toContain(
        'AND p.pr_issue_date >= ? AND p.pr_issue_date < ?',
      );
      expect(requests.values).toEqual([
        new Date(Date.UTC(2026, 0, 1)),
        new Date(Date.UTC(2027, 0, 1)),
      ]);
      // los contratos siguen por la fecha del contrato
      const [contracts] = calls[1];
      expect(contracts.sql).toContain('created_at_source >=');
    });

    it('H5: "Contratos" cuenta contratos distintos (un contrato con varias PR cuenta una vez), con el mismo año', async () => {
      const { service, prisma } = makeService();
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        // el 1051 con 2 PR (2 filas) y el 1052 con 1: 3 filas con contrato
        .mockResolvedValueOnce([
          { status: 'APPR', has_contract: true, count: 3 },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ contratos: 2, con_estatus: 3 }]);
      const summary = await service.getSummary(2026);
      expect(summary.contracts).toMatchObject({
        total: 3,
        withContract: 3,
        distinct: 2,
      });
      const [counts] = (
        prisma.$queryRaw.mock.calls as Array<
          [{ sql: string; values: unknown[] }]
        >
      )[3];
      const text = counts.sql.replace(/\s+/g, ' ');
      // sobre la vista PR–contrato, por la llave de la pestaña agrupada
      expect(text).toContain('SELECT DISTINCT ON (coalesce(prnum');
      expect(text).toContain('count(DISTINCT btrim(contractnum)) FILTER');
      expect(text).toContain(
        "has_contract AND coalesce(btrim(contractnum), '') <> ''",
      );
      // el año va por la fecha del contrato, como `withContract`
      expect(text).toContain(
        'AND created_at_source >= ? AND created_at_source < ?',
      );
      expect(counts.values).toEqual([
        new Date(Date.UTC(2026, 0, 1)),
        new Date(Date.UTC(2027, 0, 1)),
      ]);
    });

    it('H8: con año y sin ninguna PR con estatus (antes del primer full), requests = null, nunca 0; sin año es dato', async () => {
      const { service, prisma } = makeService();
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ contratos: 0, con_estatus: 0 }]);
      const conAnio = await service.getSummary(2026);
      expect(conAnio.requests).toEqual({ total: null, byStatus: [] });

      // sin año cuenta todas las PR (no depende del estatus)
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ status: null, count: 5 }])
        .mockResolvedValueOnce([{ contratos: 0, con_estatus: 0 }]);
      const sinAnio = await service.getSummary();
      expect(sinAnio.requests).toEqual({
        total: 5,
        byStatus: [{ status: null, count: 5 }],
      });
    });

    it('K8: la última corrida trae records_remapped (el primer full no se ve como ~0 / =0)', async () => {
      const { service, prisma } = makeService();
      // OC, contratos y K4.4 solicitudes
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.maximo_sync_runs.findFirst
        .mockResolvedValueOnce({
          status: 'success',
          triggered_by: 'scheduler',
          started_at: new Date('2026-10-06T06:00:30Z'),
          finished_at: new Date('2026-10-06T06:05:10Z'),
          records_inserted: 0,
          records_updated: 3,
          records_remapped: 5026,
          records_unchanged: 0,
          records_failed: 0,
        })
        .mockResolvedValueOnce(null);

      const summary = await service.getSummary();
      expect(summary.lastSync.purchase_orders).toMatchObject({
        records_updated: 3,
        records_remapped: 5026,
        records_unchanged: 0,
      });
      // el select de Prisma pide la columna (sin ella llegaría undefined)
      for (const [args] of prisma.maximo_sync_runs.findFirst.mock
        .calls as Array<[{ select: Record<string, boolean> }]>) {
        expect(args.select.records_remapped).toBe(true);
      }
      expect(prisma.maximo_sync_runs.findFirst).toHaveBeenCalledTimes(2);
    });

    it('sin flag en el env, syncEnabled=false', async () => {
      const { service, prisma } = makeService();
      prisma.$queryRaw.mockResolvedValue([]);
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
    for (const raw of [
      null,
      42,
      'x',
      [],
      { PURCHVIEW: 'no-array' },
      { Attributes: {}, RelatedMbos: { PURCHVIEW: 'no-array' } },
      { RelatedMbos: { PURCHVIEW: [{ Attributes: 'x' }, 7] } },
    ]) {
      expect(deriveContractLines(raw, '1', 0)).toEqual([]);
      expect(deriveContractStatusHistory(raw, '1', 0)).toEqual([]);
    }
  });

  it('K3.7: el raw ANIDADO se canoniza antes de buscar la revisión', () => {
    const record = findContractRecord(RAW_PR_NESTED, '9906', 1);
    expect(record?.REVISIONNUM).toBe(1);
    expect(deriveContractLines(RAW_PR_NESTED, '9906', 1)).toEqual(
      NESTED_REV1_LINES,
    );
    expect(deriveContractStatusHistory(RAW_PR_NESTED, '9906', 1)).toEqual(
      NESTED_REV1_HISTORY,
    );
    expect(deriveContractLines(RAW_PR_NESTED, '9906', 0)).toHaveLength(1);
    expect(deriveContractLines(RAW_PR_NESTED, '9906', 99)).toEqual([]);
  });

  it('K3.7: anidado y compacto del mismo registro dan lo mismo', () => {
    // el mismo contrato (rev 1 de RAW_PR_NESTED) en forma compacta
    const compact = {
      PRNUM: 'PR990006',
      rowstamp: '990100006',
      PURCHVIEW: [
        { CONTRACTNUM: '9906', REVISIONNUM: 0, CONTRACTLINE: [] },
        {
          CONTRACTNUM: '9906',
          REVISIONNUM: 1,
          rowstamp: '990160001',
          CONTRACTLINE: [
            {
              CONTRACTLINENUM: 1,
              ITEMNUM: '9990001',
              DESCRIPTION: 'Servicio demo mensual',
              ORDERQTY: 12,
              UNITCOST: 8000,
            },
            { CONTRACTLINENUM: 2, ITEMNUM: '9990002', DESCRIPTION: '~null~' },
          ],
          CONTRACTSTATUS: [
            { STATUS: 'APPR', CHANGEDATE: '2026-08-02T11:00:00+00:00' },
            { STATUS: 'PNDREV', CHANGEDATE: '2026-08-01T09:00:00+00:00' },
          ],
        },
      ],
    };
    expect(deriveContractLines(compact, '9906', 1)).toEqual(
      deriveContractLines(RAW_PR_NESTED, '9906', 1),
    );
    expect(deriveContractStatusHistory(compact, '9906', 1)).toEqual(
      deriveContractStatusHistory(RAW_PR_NESTED, '9906', 1),
    );
  });

  it('H11: historial en el mismo orden que el mapper (mismo segundo → CONTRACTSTATUSID; sin fecha al final)', () => {
    // raw anidado de prod: APPR (id 11) llega antes que WAPPR (id 10), en el
    // mismo segundo, y un cambio sin CHANGEDATE llega primero
    const raw = {
      rowstamp: '990100099',
      Attributes: { PRNUM: c('PR990099'), SITEID: c('A3T') },
      RelatedMbos: {
        PURCHVIEW: [
          {
            rowstamp: '990160099',
            Attributes: { CONTRACTNUM: c('9999'), REVISIONNUM: c(0) },
            RelatedMbos: {
              CONTRACTSTATUS: [
                {
                  Attributes: {
                    STATUS: c('DRAFT'),
                    CONTRACTSTATUSID: { content: 9, resourceid: true },
                  },
                },
                {
                  Attributes: {
                    STATUS: c('APPR'),
                    CHANGEDATE: c('2026-08-01T09:00:00+00:00'),
                    CONTRACTSTATUSID: { content: 11, resourceid: true },
                  },
                },
                {
                  Attributes: {
                    STATUS: c('WAPPR'),
                    CHANGEDATE: c('2026-08-01T09:00:00+00:00'),
                    CONTRACTSTATUSID: { content: 10, resourceid: true },
                  },
                },
              ],
            },
          },
        ],
      },
    };
    const detalle = deriveContractStatusHistory(raw, '9999', 0);
    expect(detalle).toEqual([
      { status: 'WAPPR', changedAt: '2026-08-01T09:00:00+00:00' },
      { status: 'APPR', changedAt: '2026-08-01T09:00:00+00:00' },
      { status: 'DRAFT', changedAt: null },
    ]);
    // lo que guarda el mapper, en el mismo orden
    const [dto] = toContracts(raw);
    expect(dto.statusHistory.map((s) => s.status)).toEqual(
      detalle.map((s) => s.status),
    );
  });

  it('K3.7: contrato directo en forma anidada (sin PURCHVIEW)', () => {
    const raw = {
      rowstamp: '300',
      Attributes: { CONTRACTNUM: c('1040'), REVISIONNUM: c(1) },
      RelatedMbos: {
        CONTRACTLINE: [
          { Attributes: { CONTRACTLINENUM: c(1), ITEMNUM: c('TST1ACIDO') } },
        ],
      },
    };
    expect(deriveContractLines(raw, '1040', 1).map((l) => l.itemNum)).toEqual([
      'TST1ACIDO',
    ]);
  });
});

describe('MaximoRecordsService — comprador y filtro tipo Excel (E1/E4)', () => {
  const contractRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'c-1',
    prnum: 'PR1',
    contractnum: '1051',
    revisionnum: 0,
    status: 'APPR',
    maxvol: '710481.78',
    total_cost: '710481.78',
    currency: 'MXN',
    start_date: new Date('2026-01-01T00:00:00Z'),
    end_date: new Date('2026-12-31T00:00:00Z'),
    vendor_id: 'V1',
    vendor_name: 'PROVEEDOR A',
    requested_by: 'VMM3',
    department: 'OPS',
    approved_at: new Date('2026-01-11T15:00:00Z'),
    approved_by: null,
    created_at_source: new Date('2026-01-01T15:00:00Z'),
    contract_ref_num: '1051',
    contract_value: '710481.78',
    pr_total: null,
    consumed_value: null,
    purchview_count: 1,
    has_contract: true,
    last_changed_at: null,
    last_seen_at: new Date('2026-09-25T00:00:00Z'),
    ...overrides,
  });

  it('E4: comprador = alias de Compras > DISPLAYNAME de Maximo > usuario', async () => {
    const { service, prisma, aliases } = makeService();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        poRow({
          id: 'a',
          purchase_agent: 'VMM3',
          purchase_agent_name: 'Victor M.',
        }),
        poRow({
          id: 'b',
          purchase_agent: 'JLOPEZ',
          purchase_agent_name: 'Juan López',
        }),
        poRow({
          id: 'c',
          purchase_agent: 'SINNOMBRE',
          purchase_agent_name: null,
        }),
        poRow({ id: 'd', purchase_agent: null, purchase_agent_name: null }),
      ])
      .mockResolvedValueOnce([{ count: 4 }]);
    aliases.resolveMany.mockResolvedValueOnce(
      new Map([['VMM3', 'Víctor Martínez']]),
    );
    const { data } = await service.listPurchaseOrders({});
    expect(data.map((r) => r.buyer_name)).toEqual([
      'Víctor Martínez',
      'Juan López',
      'SINNOMBRE',
      null,
    ]);
  });

  it('E1: filtra OC por comprador y ordena por monto sobre la vista completa', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw.mockResolvedValueOnce([
      poRow({
        id: 'a',
        ponum: 'PO1',
        total_cost: '10',
        purchase_agent: 'A',
        purchase_agent_name: 'Ana',
      }),
      poRow({
        id: 'b',
        ponum: 'PO2',
        total_cost: '30',
        purchase_agent: 'B',
        purchase_agent_name: 'Beto',
      }),
      poRow({
        id: 'c',
        ponum: 'PO3',
        total_cost: '20',
        purchase_agent: 'A',
        purchase_agent_name: 'Ana',
      }),
    ]);
    const result = await service.listPurchaseOrders({
      filters: JSON.stringify({ comprador: { in: ['Ana'] } }),
      sort: 'monto',
      order: 'desc',
    });
    expect(result.data.map((r) => r.ponum)).toEqual(['PO3', 'PO1']);
    expect(result.meta.total).toBe(2);
    // una sola consulta (sin count): la vista completa con tope del export
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('E1: contratos — "Sin contrato" es la faceta vacía y los días salen de solicitud→aprobación', async () => {
    const { service, prisma } = makeService();
    const rows = [
      contractRow(),
      contractRow({ id: 'c-2', prnum: 'PR2' }),
      contractRow({
        id: 'c-3',
        prnum: 'PR3',
        contractnum: null,
        has_contract: false,
        approved_at: null,
      }),
    ];
    prisma.$queryRaw.mockResolvedValue(rows);
    await expect(
      service.contractFacets({ column: 'contrato' }),
    ).resolves.toMatchObject({
      values: [
        { value: '1051', count: 2 },
        { value: null, count: 1 },
      ],
    });
    await expect(
      service.contractFacets({ column: 'dias' }),
    ).resolves.toMatchObject({
      type: 'number',
      min: 10,
      max: 10,
      empty: 1,
    });
    const exported = await service.listContractsForExport({
      filters: JSON.stringify({ contrato: { in: [null] } }),
    });
    expect(exported.rows.map((r) => r.prnum)).toEqual(['PR3']);
  });

  it('E1 (K4.4): el mismo caso con vista=solicitudes — días, solicitud y aprobación son los DE LA PR; faceta estatus_pr', async () => {
    const { service, prisma } = makeService();
    const rows = [
      // PR aprobada en 3 días; el contrato tardó 10 (fechas del contrato)
      contractRow({
        pr_status: 'CLOSE',
        pr_issue_date: new Date('2026-01-02T15:00:00Z'),
        pr_approved_at: new Date('2026-01-05T15:00:00Z'),
      }),
      contractRow({
        id: 'c-2',
        prnum: 'PR2',
        pr_status: 'CLOSE',
        pr_issue_date: new Date('2026-01-03T15:00:00Z'),
        pr_approved_at: new Date('2026-01-08T15:00:00Z'),
      }),
      // sin contrato, en aprobación: sin APPR → días vacíos
      contractRow({
        id: 'c-3',
        prnum: 'PR3',
        contractnum: null,
        has_contract: false,
        approved_at: null,
        pr_status: 'WAPPR',
        pr_issue_date: new Date('2026-02-01T15:00:00Z'),
        pr_approved_at: null,
      }),
    ];
    prisma.$queryRaw.mockResolvedValue(rows);
    await expect(
      service.contractFacets({ vista: 'solicitudes', column: 'dias' }),
    ).resolves.toMatchObject({ type: 'number', min: 3, max: 5, empty: 1 });
    await expect(
      service.contractFacets({ vista: 'solicitudes', column: 'estatus_pr' }),
    ).resolves.toMatchObject({
      values: [
        { value: 'CLOSE', count: 2 },
        { value: 'WAPPR', count: 1 },
      ],
    });
    await expect(
      service.contractFacets({ vista: 'solicitudes', column: 'solicitud' }),
    ).resolves.toMatchObject({ min: '2026-01-02', max: '2026-02-01' });
    const exported = await service.listContractsForExport({
      vista: 'solicitudes',
      filters: JSON.stringify({ estatus_pr: { in: ['WAPPR'] } }),
    });
    expect(exported.rows.map((r) => r.prnum)).toEqual(['PR3']);
    // la base es la vista POR PR (una fila por PR, sin obsoletas)
    const [sql] = prisma.$queryRaw.mock.calls[0] as [{ sql: string }];
    expect(sql.sql).toContain('DISTINCT ON (prnum)');
    expect(sql.sql).toContain('de_contrato');
  });

  it('E1 (K4.4): sin vista, estatus_pr no es columna de Contratos', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw.mockResolvedValue([contractRow()]);
    await expect(
      service.contractFacets({ column: 'estatus_pr' }),
    ).rejects.toThrow('no tiene filtro');
  });
});

describe('Contratos Maximo agrupados por contrato (E2)', () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: 'c',
    prnum: 'PR1',
    contractnum: '1051',
    revisionnum: 0,
    status: 'APPR',
    maxvol: '710481.78',
    total_cost: '710481.78',
    currency: 'MXN',
    start_date: new Date('2026-01-01T00:00:00Z'),
    end_date: new Date('2026-12-31T00:00:00Z'),
    vendor_id: 'V1',
    vendor_name: 'PROVEEDOR A',
    requested_by: 'VMM3',
    department: 'OPS',
    approved_at: null,
    approved_by: null,
    created_at_source: new Date('2026-01-01T15:00:00Z'),
    contract_ref_num: '1051',
    contract_value: '710481.78',
    pr_total: null,
    consumed_value: null,
    purchview_count: 1,
    has_contract: true,
    last_changed_at: null,
    last_seen_at: new Date('2026-09-25T00:00:00Z'),
    ...overrides,
  });

  it('una fila por contrato (revisión más alta) con sus PR; las PR sin contrato no entran', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw.mockResolvedValueOnce([
      row({
        id: 'a',
        prnum: 'PR1',
        created_at_source: new Date('2026-02-01T00:00:00Z'),
      }),
      row({
        id: 'b',
        prnum: 'PR2',
        revisionnum: 1,
        contract_value: '800000',
        created_at_source: new Date('2026-03-01T00:00:00Z'),
      }),
      row({
        id: 'c',
        prnum: 'PR3',
        created_at_source: new Date('2026-01-15T00:00:00Z'),
      }),
      row({
        id: 'd',
        prnum: 'PR9',
        contractnum: '2000',
        end_date: new Date('2027-06-30T00:00:00Z'),
      }),
    ]);
    const result = await service.listContractGroups({ group: 'contract' });
    expect(result.meta.total).toBe(2);
    // fin de vigencia más lejano primero
    expect(result.data.map((g) => g.contractnum)).toEqual(['2000', '1051']);
    const g1051 = result.data[1];
    expect(g1051).toMatchObject({
      pr_count: 3,
      revisionnum: 1,
      contract_value: 800000,
      detail_key: 'PR2',
    });
    expect(g1051.prs.map((p) => p.prnum)).toEqual(['PR2', 'PR1', 'PR3']);
    // la consulta pidió solo filas con contrato
    const sql = (
      prisma.$queryRaw.mock.calls[0] as [
        { strings: string[]; values: unknown[] },
      ]
    )[0];
    expect(sql.strings.join('?')).toContain('has_contract');
    expect(sql.values).toContain(true);
  });

  it('filtros por columna y facetas sobre los contratos agrupados', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw.mockResolvedValue([
      row({ id: 'a', prnum: 'PR1' }),
      row({ id: 'b', prnum: 'PR2' }),
      row({ id: 'c', prnum: 'PR3', contractnum: '3000', status: 'EXPIRD' }),
    ]);
    const filtered = await service.listContractGroups({
      group: 'contract',
      filters: JSON.stringify({ solicitudes: { min: 2 } }),
    });
    expect(filtered.data.map((g) => g.contractnum)).toEqual(['1051']);
    await expect(
      service.contractGroupFacets({ group: 'contract', column: 'estatus' }),
    ).resolves.toMatchObject({
      values: [
        { value: 'APPR', count: 1 },
        { value: 'EXPIRD', count: 1 },
      ],
    });
  });
});

describe('MaximoRecordsService — comprador de respaldo (F1)', () => {
  it('sin PURCHASEAGENT: "Capturó: …" con quien creó la OC; filtrable aparte del comprador', async () => {
    const { service, prisma, aliases } = makeService();
    prisma.$queryRaw.mockResolvedValue([
      poRow({
        id: 'a',
        ponum: 'PO1',
        purchase_agent: 'DYMP1',
        purchase_agent_name: 'Diana Yohara',
        created_by: 'X',
      }),
      poRow({
        id: 'b',
        ponum: 'PO2',
        purchase_agent: null,
        purchase_agent_name: null,
        created_by: 'DYMP1',
      }),
      poRow({
        id: 'c',
        ponum: 'PO3',
        purchase_agent: null,
        purchase_agent_name: null,
        created_by: null,
      }),
    ]);
    aliases.resolveMany.mockResolvedValue(new Map([['DYMP1', 'Diana Yohara']]));
    const { data } = await service.listPurchaseOrders({ sort: 'ponum' });
    expect(data.map((r) => [r.buyer_name, r.buyer_kind])).toEqual([
      ['Diana Yohara', 'comprador'],
      ['Diana Yohara', 'capturo'],
      [null, null],
    ]);
    await expect(
      service.purchaseOrderFacets({ column: 'comprador' }),
    ).resolves.toMatchObject({
      // empate de conteo: orden alfabético, las vacías al final
      values: [
        { value: 'Capturó: Diana Yohara', count: 1 },
        { value: 'Diana Yohara', count: 1 },
        { value: null, count: 1 },
      ],
    });
  });
});

describe('MaximoRecordsService — proveedor efectivo (G1, 2026-09-28)', () => {
  const ASOCIACION = 'ASOCIACION MEXICANA DE ENERGIA';
  const NAES = 'NAES ENERGIA S DE RL DE CV';
  // PO1 migró a SAP a nombre de NAES; PO2 (sin migrar) toma el cruce
  const xref = buildVendorXref(
    [
      {
        ponum: 'PO1',
        vendor_id: 'P0000440',
        vendor_name: ASOCIACION,
        card_code: 'P0000219',
        card_name: NAES,
      },
      {
        ponum: 'PO9',
        vendor_id: 'P0000440',
        vendor_name: ASOCIACION,
        card_code: 'P0000219',
        card_name: NAES,
      },
    ],
    new Map([['P0000219', NAES]]),
  );
  const rows = () => [
    poRow({
      id: 'a',
      ponum: 'PO1',
      vendor_id: 'P0000440',
      vendor_name: ASOCIACION,
    }),
    poRow({
      id: 'b',
      ponum: 'PO2',
      vendor_id: 'P0000440',
      vendor_name: ASOCIACION,
    }),
    poRow({
      id: 'c',
      ponum: 'PO3',
      vendor_id: 'P0000500',
      vendor_name: 'LOCAL SA DE CV',
    }),
  ];

  it('columna, nota "en Maximo" y filtro por proveedor efectivo (desde el top de Reportes)', async () => {
    const { service, prisma } = makeService({}, xref);
    prisma.$queryRaw.mockResolvedValueOnce(rows());
    const result = await service.listPurchaseOrders({
      proveedor: 'sap:P0000219',
    });
    expect(result.data.map((r) => [r.ponum, r.supplier_source])).toEqual([
      ['PO1', 'sap_oc'],
      ['PO2', 'sap_cruce'],
    ]);
    expect(result.data[0]).toMatchObject({
      supplier_key: 'sap:P0000219',
      supplier_code: 'P0000219',
      supplier_name: NAES,
      supplier_note: `en Maximo: ${ASOCIACION} (P0000440)`,
      vendor_name: ASOCIACION, // lo del maestro de Maximo se conserva
    });
    // el filtro por proveedor efectivo va sobre la vista completa (una consulta)
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('la faceta del filtro tipo Excel lista el proveedor efectivo', async () => {
    const { service, prisma } = makeService({}, xref);
    prisma.$queryRaw.mockResolvedValueOnce(rows());
    const facet = await service.purchaseOrderFacets({ column: 'proveedor' });
    if (!('values' in facet)) throw new Error('faceta de texto esperada');
    expect(facet.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: NAES, count: 2 }),
        expect.objectContaining({ value: 'LOCAL SA DE CV', count: 1 }),
      ]),
    );
    expect(facet.values.some((v) => v.value === ASOCIACION)).toBe(false);
  });
});

describe('Solicitudes Maximo (K4.4, vista=solicitudes)', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'r-1',
    prnum: 'PR990002',
    contractnum: null,
    revisionnum: null,
    status: 'APPR',
    maxvol: null,
    total_cost: null,
    currency: null,
    start_date: null,
    end_date: null,
    vendor_id: null,
    vendor_name: null,
    requested_by: 'USR001',
    department: null,
    approved_at: null,
    approved_by: null,
    created_at_source: null,
    contract_ref_num: null,
    contract_value: null,
    pr_total: '1500',
    consumed_value: null,
    pr_status: 'APPR',
    pr_issue_date: new Date('2026-09-14T15:00:00Z'),
    pr_approved_at: new Date('2026-09-15T09:00:00Z'),
    pr_status_date: new Date('2026-09-18T13:15:00Z'),
    purchview_count: 0,
    has_contract: false,
    has_po: false,
    last_changed_at: null,
    last_seen_at: new Date('2026-10-05T00:00:00Z'),
    ...overrides,
  });

  type SqlCall = [{ sql: string; values: unknown[] }];
  const firstSql = (mock: jest.Mock) => {
    const [arg] = mock.mock.calls[0] as SqlCall;
    return { text: arg.sql.replace(/\s+/g, ' '), values: arg.values };
  };
  const Y2026 = new Date(Date.UTC(2026, 0, 1));
  const Y2027 = new Date(Date.UTC(2027, 0, 1));

  it('una fila por PR (vista por PR, sin obsoletas), con estatus y fechas de la PR; el año va por ISSUEDATE', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([{ count: 1 }]);
    const result = await service.listContracts({
      vista: 'solicitudes',
      year: 2026,
    });
    expect(result.data[0]).toMatchObject({
      prnum: 'PR990002',
      pr_status: 'APPR',
      pr_issue_date: new Date('2026-09-14T15:00:00Z'),
      pr_approved_at: new Date('2026-09-15T09:00:00Z'),
      pr_status_date: new Date('2026-09-18T13:15:00Z'),
    });
    const { text, values } = firstSql(prisma.$queryRaw);
    expect(text).toContain('DISTINCT ON (prnum)');
    expect(text).toContain('superseded_at IS NULL');
    expect(text).toContain(
      'pr_status, pr_issue_date, pr_approved_at, pr_status_date',
    );
    expect(text).toContain('AND c.pr_issue_date >= ? AND c.pr_issue_date < ?');
    expect(text).not.toContain('c.created_at_source >=');
    expect(text).toContain('ORDER BY c.pr_issue_date DESC NULLS LAST');
    expect(values).toEqual(expect.arrayContaining([Y2026, Y2027]));
    // el conteo usa la misma base
    const [count] = prisma.$queryRaw.mock.calls[1] as SqlCall;
    expect(count.sql).toContain('DISTINCT ON (prnum)');
  });

  it('sin `vista`, Contratos no cambia: vista de contratos y año por la fecha del contrato', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw
      .mockResolvedValueOnce([row({ has_contract: true, contractnum: '9906' })])
      .mockResolvedValueOnce([{ count: 1 }]);
    await service.listContracts({ year: 2026 });
    const { text } = firstSql(prisma.$queryRaw);
    expect(text).toContain(
      "DISTINCT ON (coalesce(prnum, ''), coalesce(contractnum, ''))",
    );
    expect(text).not.toContain('DISTINCT ON (prnum)');
    expect(text).toContain(
      'AND c.created_at_source >= ? AND c.created_at_source < ?',
    );
    expect(text).not.toContain('pr_issue_date >=');
    expect(text).toContain('ORDER BY c.end_date DESC NULLS LAST');
  });

  it('sin_oc implica la vista: APPR sin OC ni contrato y el año por la llegada a Compras (cuadra con la tarjeta)', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }]);
    await service.listContracts({ sin_oc: 'true', year: 2026 });
    const { text, values } = firstSql(prisma.$queryRaw);
    expect(text).toContain('DISTINCT ON (prnum)');
    expect(text).toContain("(c.pr_status = 'APPR' AND NOT c.de_contrato");
    expect(text).toContain(
      'AND coalesce(c.pr_approved_at, c.pr_issue_date) >= ? AND coalesce(c.pr_approved_at, c.pr_issue_date) < ?',
    );
    expect(text).not.toContain('regexp_replace');
    expect(values).toEqual(expect.arrayContaining([Y2026, Y2027]));
  });

  it('contrato_sin_oc con pr_desde (llegada); en_aprobacion = WAPPR por emisión; pr_status por lista', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw.mockResolvedValue([]);
    await service.listContracts({
      contrato_sin_oc: 'true',
      pr_desde: '2025-10-05',
    });
    let { text, values } = firstSql(prisma.$queryRaw);
    expect(text).toContain("(c.pr_status = 'APPR' AND c.de_contrato");
    expect(text).toContain(
      'AND coalesce(c.pr_approved_at, c.pr_issue_date) >= ?',
    );
    expect(text).not.toContain('< ?');
    expect(values).toContainEqual(new Date('2025-10-05'));

    prisma.$queryRaw.mockClear();
    await service.listContracts({ en_aprobacion: 'true', year: 2026 });
    ({ text } = firstSql(prisma.$queryRaw));
    expect(text).toContain('DISTINCT ON (prnum)');
    expect(text).toContain("(c.pr_status = 'WAPPR')");
    expect(text).toContain('AND c.pr_issue_date >= ? AND c.pr_issue_date < ?');

    prisma.$queryRaw.mockClear();
    await service.listContracts({ pr_status: ['APPR', 'WAPPR'] });
    ({ text, values } = firstSql(prisma.$queryRaw));
    expect(text).toContain('DISTINCT ON (prnum)');
    expect(text).toContain('c.pr_status IN (?,?)');
    expect(values).toEqual(expect.arrayContaining(['APPR', 'WAPPR']));
  });

  it('agrupado (sin vista): prs[] con el estatus y las fechas de la PR', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw.mockResolvedValueOnce([
      row({
        prnum: 'PR990006',
        contractnum: '9906',
        revisionnum: 1,
        has_contract: true,
        status: 'APPR',
        pr_status: 'CLOSE',
        pr_issue_date: new Date('2026-06-10T14:00:00Z'),
        pr_approved_at: new Date('2026-06-11T09:00:00Z'),
      }),
    ]);
    const result = await service.listContractGroups({ group: 'contract' });
    expect(result.data[0].status).toBe('APPR'); // el del contrato
    expect(result.data[0].prs).toEqual([
      expect.objectContaining({
        prnum: 'PR990006',
        status: 'APPR',
        pr_status: 'CLOSE',
        pr_issue_date: new Date('2026-06-10T14:00:00Z'),
        pr_approved_at: new Date('2026-06-11T09:00:00Z'),
      }),
    ]);
    const { text } = firstSql(prisma.$queryRaw);
    expect(text).not.toContain('DISTINCT ON (prnum)');
  });
});

/**
 * K7.1 (2026-10-05): OC de Maximo con dos sistemas a la vista. Raw de la OC
 * INLINE en la forma legacy ANIDADA de prod (Attributes/RelatedMbos), con las
 * líneas desordenadas, una sin número, un ITEM hijo y banderas en varias
 * formas. Valores dummy.
 */
const RAW_PO_NESTED = {
  rowstamp: '990104897',
  Attributes: {
    PONUM: c('PO990897'),
    SITEID: c('A3T'),
    STATUS: c('INPRG'),
    RECEIPTS: c('PARTIAL'),
    PO5: c('PROCESADO'),
  },
  RelatedMbos: {
    POLINE: [
      {
        rowstamp: '990148903',
        Attributes: {
          POLINENUM: c(3),
          ITEMNUM: c('~null~'),
          DESCRIPTION: c('Servicio demo de calibración'),
          RECEIVEDQTY: c(0),
          LINECOST: c(500),
          RECEIPTSCOMPLETE: c(false),
        },
      },
      {
        rowstamp: '990148909',
        Attributes: {
          DESCRIPTION: c('Línea demo sin número'),
          LINECOST: c(10),
        },
      },
      {
        rowstamp: '990148901',
        Attributes: {
          POLINENUM: c(1),
          ITEMNUM: c('9990001'),
          DESCRIPTION: c('Refacción demo A'),
          RECEIVEDQTY: c(2),
          LINECOST: c(1000.1),
          RECEIPTSCOMPLETE: c('1'),
        },
      },
      {
        rowstamp: '990148902',
        Attributes: {
          POLINENUM: c(2),
          RECEIVEDQTY: c(1),
          LINECOST: c(254.95),
          RECEIPTSCOMPLETE: c('0'),
        },
        RelatedMbos: {
          ITEM: [
            {
              rowstamp: '990148912',
              Attributes: {
                ITEMNUM: c('9990002'),
                DESCRIPTION: c('Artículo demo B'),
              },
            },
          ],
        },
      },
    ],
  },
};

/** Lo que el detalle debe derivar de RAW_PO_NESTED. */
const RAW_PO_NESTED_LINES = [
  {
    line_num: 1,
    item_num: '9990001',
    description: 'Refacción demo A',
    received_qty: 2,
    line_cost: 1000.1,
    receipts_complete: true,
  },
  {
    line_num: 2,
    item_num: '9990002',
    description: 'Artículo demo B',
    received_qty: 1,
    line_cost: 254.95,
    receipts_complete: false,
  },
  {
    line_num: 3,
    item_num: null,
    description: 'Servicio demo de calibración',
    received_qty: 0,
    line_cost: 500,
    receipts_complete: false,
  },
  {
    line_num: null,
    item_num: null,
    description: 'Línea demo sin número',
    received_qty: null,
    line_cost: 10,
    receipts_complete: null,
  },
];

describe('Órdenes Maximo: recepción, integración, subtotal y OC de SAP (K7.1)', () => {
  type SqlCall = [{ sql: string; values: unknown[] }];
  const sqlOf = (mock: jest.Mock, i = 0) => {
    const [arg] = mock.mock.calls[i] as SqlCall;
    return { text: arg.sql.replace(/\s+/g, ' '), values: arg.values };
  };

  /** OC de prueba con los cuatro campos (PO104896 del seed de dev). */
  const k7Rows = () => [
    poRow({
      id: 'a',
      ponum: 'PO1',
      receipt_status: 'COMPLETE',
      integration_status: 'PROCESADO',
      subtotal: '100.00',
      oc_sap: 6337,
    }),
    poRow({
      id: 'b',
      ponum: 'PO2',
      receipt_status: 'PARTIAL',
      integration_status: 'ERROR',
      subtotal: null,
      oc_sap: null,
    }),
    poRow({
      id: 'c',
      ponum: 'PO3',
      receipt_status: null,
      integration_status: null,
      subtotal: '300.00',
      oc_sap: 10001,
    }),
    poRow({
      id: 'd',
      ponum: 'PO4',
      receipt_status: 'COMPLETE',
      integration_status: null,
      subtotal: '50.00',
      oc_sap: 6400,
    }),
  ];

  it('la fila trae receipt_status, integration_status, subtotal (number) y oc_sap; el SELECT los pide', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        poRow({
          ponum: 'PO104896',
          total_cost: '1755.00',
          receipt_status: 'COMPLETE',
          integration_status: 'PROCESADO',
          subtotal: '1755.00',
          oc_sap: 6337,
        }),
        // sin los campos (filas previas al mapper de K2/K6): null, no undefined
        poRow({ id: 'po-2', ponum: 'PO2' }),
      ])
      .mockResolvedValueOnce([{ count: 2 }]);
    const { data } = await service.listPurchaseOrders({});
    expect(data[0]).toMatchObject({
      ponum: 'PO104896',
      receipt_status: 'COMPLETE',
      integration_status: 'PROCESADO',
      subtotal: 1755,
      oc_sap: 6337,
      total_cost: 1755,
    });
    expect(data[1]).toMatchObject({
      receipt_status: null,
      integration_status: null,
      subtotal: null,
      oc_sap: null,
    });
    const { text } = sqlOf(prisma.$queryRaw);
    expect(text).toContain('receipt_status, integration_status, subtotal,');
    // la regla de Expeditación: min(DocNum) de las copias, sin columna nueva
    expect(text).toContain(
      '(SELECT min(s.doc_num) FROM sap_purchase_orders s WHERE s.maximo_ponum = c.ponum) AS oc_sap',
    );
  });

  it('la búsqueda también encuentra por la OC de SAP (DocNum de sus copias)', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0 }]);
    await service.listPurchaseOrders({ search: '6337' });
    for (const i of [0, 1]) {
      const { text, values } = sqlOf(prisma.$queryRaw, i);
      expect(text).toContain(
        '(c.ponum ILIKE ? OR c.description ILIKE ? OR EXISTS (SELECT 1 FROM sap_purchase_orders s WHERE s.maximo_ponum = c.ponum AND s.doc_num::text ILIKE ?))',
      );
      expect(values.filter((v) => v === '%6337%')).toHaveLength(3);
    }
  });

  it('filtros por columna recepcion e integracion con las etiquetas de Expeditación', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw.mockResolvedValue(k7Rows());
    const completa = await service.listPurchaseOrders({
      filters: JSON.stringify({ recepcion: { in: ['Completa'] } }),
    });
    expect(completa.data.map((r) => r.ponum)).toEqual(['PO1', 'PO4']);
    const sinDato = await service.listPurchaseOrders({
      filters: JSON.stringify({ integracion: { in: ['Sin dato'] } }),
    });
    expect(sinDato.data.map((r) => r.ponum)).toEqual(['PO3', 'PO4']);
    await expect(
      service.purchaseOrderFacets({ column: 'recepcion' }),
    ).resolves.toMatchObject({
      type: 'text',
      values: [
        { value: 'Completa', count: 2 },
        { value: 'No disponible', count: 1 },
        { value: 'Parcial', count: 1 },
      ],
    });
    await expect(
      service.purchaseOrderFacets({ column: 'integracion' }),
    ).resolves.toMatchObject({
      values: [
        { value: 'Sin dato', count: 2 },
        { value: 'Error', count: 1 },
        { value: 'Procesado', count: 1 },
      ],
    });
  });

  it('filtros por columna oc_sap (texto, orden numérico) y subtotal (rango)', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw.mockResolvedValue(k7Rows());
    const porOc = await service.listPurchaseOrders({
      filters: JSON.stringify({ oc_sap: { in: ['6337'] } }),
    });
    expect(porOc.data.map((r) => r.ponum)).toEqual(['PO1']);
    const ordenadas = await service.listPurchaseOrders({ sort: 'oc_sap' });
    // 6337 < 6400 < 10001 (no alfabético); sin OC al final
    expect(ordenadas.data.map((r) => r.ponum)).toEqual([
      'PO1',
      'PO4',
      'PO3',
      'PO2',
    ]);
    const desde60 = await service.listPurchaseOrders({
      filters: JSON.stringify({ subtotal: { min: 60 } }),
    });
    expect(desde60.data.map((r) => r.ponum)).toEqual(['PO1', 'PO3']);
    const sinSubtotal = await service.listPurchaseOrders({
      filters: JSON.stringify({ subtotal: { empty: true } }),
    });
    expect(sinSubtotal.data.map((r) => r.ponum)).toEqual(['PO2']);
    await expect(
      service.purchaseOrderFacets({ column: 'subtotal' }),
    ).resolves.toMatchObject({ type: 'number', min: 50, max: 300, empty: 1 });
    // el monto (TOTALCOST) sigue en su propia columna
    await expect(
      service.purchaseOrderFacets({ column: 'monto' }),
    ).resolves.toMatchObject({ type: 'number', empty: 0 });
  });

  it('detalle: los cuatro campos, la OC de SAP de sus copias y las líneas del raw ANIDADO, por número', async () => {
    const { service, prisma } = makeService();
    prisma.maximo_purchase_orders.findMany.mockResolvedValue([
      poRow({
        id: 'po-r0',
        ponum: 'PO990897',
        revisionnum: 0,
        receipt_status: 'PARTIAL',
        integration_status: 'PROCESADO',
        subtotal: '1765.05',
        raw: { PONUM: 'PO990897' },
      }),
      poRow({
        id: 'po-r1',
        ponum: 'PO990897',
        revisionnum: 1,
        receipt_status: 'PARTIAL',
        integration_status: 'PROCESADO',
        subtotal: '1765.05',
        raw: RAW_PO_NESTED,
      }),
    ]);
    prisma.sap_purchase_orders.aggregate.mockResolvedValue({
      _min: { doc_num: 6338 },
    });

    const detail = await service.getPurchaseOrder('PO990897', false);
    expect(prisma.sap_purchase_orders.aggregate).toHaveBeenCalledWith({
      where: { maximo_ponum: 'PO990897' },
      _min: { doc_num: true },
    });
    expect(detail.current).toMatchObject({
      revisionnum: 1,
      receipt_status: 'PARTIAL',
      integration_status: 'PROCESADO',
      subtotal: 1765.05,
      oc_sap: 6338,
    });
    // las de la revisión actual, aunque el raw no se mande (no es admin)
    expect('raw' in detail.current).toBe(false);
    expect(detail.lines).toEqual(RAW_PO_NESTED_LINES);
  });

  it('detalle sin copias en SAP ni POLINE: oc_sap null y sin líneas', async () => {
    const { service, prisma } = makeService();
    prisma.maximo_purchase_orders.findMany.mockResolvedValue([poRow()]);
    const detail = await service.getPurchaseOrder('PO102249', false);
    expect(detail.current.oc_sap).toBeNull();
    expect(detail.lines).toEqual([]);
  });
});

describe('derivación pura de las líneas de la OC (K7.1)', () => {
  it('anidado y compacto del mismo registro dan lo mismo', () => {
    const compact = {
      PONUM: 'PO990897',
      rowstamp: '990104897',
      POLINE: [
        {
          POLINENUM: 3,
          ITEMNUM: '~null~',
          DESCRIPTION: 'Servicio demo de calibración',
          RECEIVEDQTY: 0,
          LINECOST: 500,
          RECEIPTSCOMPLETE: false,
        },
        { DESCRIPTION: 'Línea demo sin número', LINECOST: 10 },
        {
          POLINENUM: 1,
          ITEMNUM: '9990001',
          DESCRIPTION: 'Refacción demo A',
          RECEIVEDQTY: 2,
          LINECOST: 1000.1,
          RECEIPTSCOMPLETE: '1',
        },
        {
          POLINENUM: 2,
          RECEIVEDQTY: 1,
          LINECOST: 254.95,
          RECEIPTSCOMPLETE: '0',
          ITEM: [{ ITEMNUM: '9990002', DESCRIPTION: 'Artículo demo B' }],
        },
      ],
    };
    expect(derivePurchaseOrderLines(compact)).toEqual(RAW_PO_NESTED_LINES);
    expect(derivePurchaseOrderLines(RAW_PO_NESTED)).toEqual(
      RAW_PO_NESTED_LINES,
    );
  });

  it('la descripción de la línea gana a la del artículo; números en texto se leen', () => {
    const raw = {
      POLINE: [
        {
          POLINENUM: '7',
          DESCRIPTION: 'Descripción de la OC',
          RECEIVEDQTY: '1.5',
          LINECOST: '99.90',
          RECEIPTSCOMPLETE: 'Y',
          ITEM: [{ ITEMNUM: 'X1', DESCRIPTION: 'Descripción del catálogo' }],
        },
      ],
    };
    expect(derivePurchaseOrderLines(raw)).toEqual([
      {
        line_num: 7,
        item_num: 'X1',
        description: 'Descripción de la OC',
        received_qty: 1.5,
        line_cost: 99.9,
        receipts_complete: true,
      },
    ]);
  });

  it('formas inesperadas devuelven vacío sin lanzar', () => {
    for (const raw of [
      null,
      42,
      'x',
      [],
      { POLINE: 'no-array' },
      { Attributes: {}, RelatedMbos: { POLINE: 'no-array' } },
      { RelatedMbos: { POLINE: [] } },
    ]) {
      expect(derivePurchaseOrderLines(raw)).toEqual([]);
    }
    // hijos que no son objeto se ignoran
    expect(
      derivePurchaseOrderLines({ POLINE: [7, 'x', { POLINENUM: 1 }] }),
    ).toHaveLength(1);
  });
});

describe('Exports de Maximo y estatus de la PR (K7)', () => {
  /** Vista de OC mínima para los exports (lo demás, null). */
  const poView = (
    overrides: Partial<MaximoPurchaseOrderView>,
  ): MaximoPurchaseOrderView => ({
    id: 'po',
    ponum: 'PO104896',
    siteid: 'A3T',
    revisionnum: 0,
    status: 'INPRG',
    description: null,
    vendor_id: null,
    vendor_name: null,
    total_cost: 2035.8,
    currency: 'EUR',
    ab_ahorro: null,
    ab_tipocomp: null,
    ab_clasfpo: null,
    requested_by: null,
    requested_by_name: null,
    purchase_agent: null,
    purchase_agent_name: null,
    created_by: null,
    buyer_name: null,
    buyer_kind: null,
    department: null,
    approved_at: null,
    approved_by: null,
    approved_by_name: null,
    waiting_approval_at: null,
    created_at_source: null,
    receipt_status: 'COMPLETE',
    integration_status: 'PROCESADO',
    subtotal: 1755,
    oc_sap: 6337,
    last_changed_at: null,
    last_seen_at: new Date('2026-10-05T00:00:00Z'),
    supplier_key: null,
    supplier_code: null,
    supplier_name: null,
    supplier_source: null,
    supplier_note: null,
    ...overrides,
  });

  const readSheet = async (buffer: Buffer, name: string) => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = book.getWorksheet(name)!;
    const header = (sheet.getRow(1).values as unknown[]).map(String);
    const row = (n: number) => sheet.getRow(n).values as unknown[];
    return { header, row };
  };

  it('Órdenes Maximo: Recepción, Integración SAP, OC SAP, Subtotal (sin IVA) y Total (con IVA)', async () => {
    const headers = PO_COLUMNS.map((col) => col.header);
    expect(headers).not.toContain('Monto');
    const estatus = headers.indexOf('Estatus');
    expect(headers.slice(estatus, estatus + 4)).toEqual([
      'Estatus',
      'Recepción',
      'Integración SAP',
      'OC SAP',
    ]);
    expect(headers.indexOf('Total (con IVA)')).toBe(
      headers.indexOf('Subtotal (sin IVA)') + 1,
    );

    const buffer = await buildExcel('Ordenes Maximo', PO_COLUMNS, [
      poView({}),
      poView({
        ponum: 'PO2',
        receipt_status: null,
        integration_status: null,
        subtotal: null,
        oc_sap: null,
      }),
    ]);
    const { header, row } = await readSheet(buffer, 'Ordenes Maximo');
    const cell = (n: number, h: string) => row(n)[header.indexOf(h)];
    expect(cell(2, 'Recepción')).toBe('Completa');
    expect(cell(2, 'Integración SAP')).toBe('Procesado');
    expect(cell(2, 'OC SAP')).toBe(6337);
    expect(cell(2, 'Subtotal (sin IVA)')).toBe(1755);
    expect(cell(2, 'Total (con IVA)')).toBe(2035.8);
    // sin dato: "No disponible" / "Sin dato", nunca un monto estimado
    expect(cell(3, 'Recepción')).toBe('No disponible');
    expect(cell(3, 'Integración SAP')).toBe('Sin dato');
    expect(cell(3, 'OC SAP')).toBeUndefined();
    expect(cell(3, 'Subtotal (sin IVA)')).toBe('No disponible');
  });

  it('L3: el estatus de Órdenes Maximo con las palabras del cliente y el código entre paréntesis', async () => {
    const statuses = [
      'INPRG',
      'HOLD',
      'PNDREV',
      'REVISD',
      'APPR5',
      'APPR2REV',
      'WAPPR',
      'CAN',
      'WSTART',
      null,
    ];
    const buffer = await buildExcel(
      'Ordenes Maximo',
      PO_COLUMNS,
      statuses.map((status, i) => poView({ ponum: `PO${i}`, status })),
    );
    const { header, row } = await readSheet(buffer, 'Ordenes Maximo');
    expect(
      statuses.map((_, i) => row(i + 2)[header.indexOf('Estatus')]),
    ).toEqual([
      'En progreso (INPRG)',
      'En suspenso (HOLD)',
      'Revisión pendiente (PNDREV)',
      'Revisada (REVISD)',
      'Autorización 5 (APPR5)',
      'Autorización 2 (APPR2REV)',
      'En espera de aprobación (WAPPR)',
      'Cancelada (CAN)',
      // desconocido: el código tal cual; sin estatus: celda vacía
      'WSTART',
      undefined,
    ]);
  });

  it('K6.9: "Monto de la PR (Maximo)" en Contratos y Solicitudes; "Estatus PR" con el mapa de las PR', () => {
    for (const columns of [CONTRACT_COLUMNS, REQUEST_COLUMNS]) {
      const headers = columns.map((col) => col.header);
      expect(headers).toContain('Monto de la PR (Maximo)');
      expect(headers).not.toContain('Monto PR');
    }
    const estatusPr = REQUEST_COLUMNS.find(
      (col) => col.header === 'Estatus PR',
    )!;
    const pr = (pr_status: string | null) =>
      estatusPr.value({ pr_status } as MaximoContractView);
    expect(pr('APPR')).toBe('Aprobada: llegó a Compras (APPR)');
    expect(pr('WAPPR')).toBe('En aprobación (WAPPR)');
    expect(pr('CLOSE')).toBe('Cerrada (CLOSE)');
    expect(pr('CAN')).toBe('Cancelada (CAN)');
    expect(pr(null)).toBe('No disponible');
  });

  it('mapa de estatus de la PR: aparte del de OC; desconocido tal cual', () => {
    expect(MAXIMO_PR_STATUS_LABELS).toEqual({
      WAPPR: 'En aprobación',
      APPR: 'Aprobada: llegó a Compras',
      CLOSE: 'Cerrada',
      CAN: 'Cancelada',
    });
    expect(maximoPrStatusLabel('APPR')).toBe('Aprobada: llegó a Compras');
    expect(maximoPrStatusLabel('DRAFT')).toBe('DRAFT');
    expect(maximoPrStatusLabel(null)).toBe('');
    expect(maximoPrStatusWithCode('DRAFT')).toBe('DRAFT');
    expect(maximoPrStatusWithCode(null)).toBe('');
    // el de OC no cambia
    expect(maximoStatusWithCode('APPR')).toBe('Aprobada (APPR)');
    expect(maximoStatusWithCode('WAPPR')).toBe(
      'En espera de aprobación (WAPPR)',
    );
  });
});
