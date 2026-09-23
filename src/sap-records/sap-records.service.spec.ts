import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { SapRecordsService } from './sap-records.service';

/**
 * Fase INT-4. Lectura de dominio con Prisma mockeado — sin BD. Cubre:
 * listado paginado con filtros (alias de estatus → bost_*, búsqueda por
 * texto y numérica), detalle con líneas derivadas del raw ("sin dato" =
 * null, nunca el placeholder del ERP), control de acceso al `raw` y el
 * resumen para el dashboard.
 */

const PO_ROW = {
  id: 'row-1',
  doc_entry: 9000,
  doc_num: 6121,
  doc_date: new Date('2026-07-01T00:00:00Z'),
  doc_due_date: null,
  update_date_source: null,
  document_status: 'bost_Open',
  comments: null,
  card_code: 'P0000788',
  card_name: 'PROVEEDOR UNO',
  doc_total: '1335149.25', // Decimal llega como string en el mock
  currency: 'MXN',
  lines_total: 2,
  lines_classified: 0,
  ahorro_total: null,
  open_total: '667574.63',
  user_sign: 38,
  created_by_name: 'Comprador Uno',
  maximo_ponum: null,
  base_request_entries: [120],
  last_changed_at: null,
  last_seen_at: new Date(),
  raw: {
    DocEntry: 9000,
    DocCurrency: 'MXN',
    DocumentLines: [
      {
        LineNum: 0,
        ItemCode: 'A1',
        ItemDescription: 'Empaque',
        LineTotal: 100,
        GrossTotal: 116,
        Quantity: 10,
        RemainingOpenQuantity: 4,
        LineStatus: 'bost_Open',
        Currency: 'MXN',
        U_Clas_gts: 'SELECCIONAR',
        U_Imp_ahorro: null,
        U_Proc_Comp: 'SELECCIONAR',
      },
      {
        LineNum: 1,
        ItemCode: 'A2',
        U_Clas_gts: 'OPEX',
        U_Imp_ahorro: 50,
        U_Proc_Comp: 'Licitación',
      },
    ],
  },
};

function makeService() {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    sap_approval_requests: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    sap_purchase_orders: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([PO_ROW]),
      findFirst: jest.fn().mockResolvedValue(PO_ROW),
      groupBy: jest.fn().mockResolvedValue([
        { document_status: 'bost_Open', _count: { _all: 3 } },
        { document_status: 'bost_Close', _count: { _all: 7 } },
      ]),
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: 10 },
        _sum: { doc_total: '5000.50', lines_total: 30, lines_classified: 4 },
      }),
    },
    sap_purchase_requests: {
      count: jest.fn().mockResolvedValue(0),
      // Solicitud base de PO_ROW (solicitante de la OC)
      findMany: jest
        .fn()
        .mockResolvedValue([
          { doc_entry: 120, requester_name: 'Erín VALVERDE', requester: 'u27' },
        ]),
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: 0 },
        _sum: { doc_total: null, lines_total: null, lines_classified: null },
      }),
    },
    sap_sync_runs: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  // count de docs con ahorro (2a llamada a count en el summary)
  prisma.sap_purchase_orders.count.mockResolvedValue(2);

  const config = {
    // Forma REAL post-Joi: boolean (la validación convierte 'true' → true).
    get: jest.fn((key: string) => (key === 'SAP_SYNC_ENABLED' ? true : '')),
  };
  const aliases = {
    resolveMany: jest.fn().mockResolvedValue(new Map<string, string>()),
    displayName: jest.fn((_s: string, code: string | null) =>
      Promise.resolve(code),
    ),
    forProfiles: jest.fn().mockResolvedValue([]),
    byCode: jest.fn().mockResolvedValue(new Map()),
  };
  const service = new SapRecordsService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    aliases as unknown as ErpAliasesService,
  );
  return { service, prisma };
}

describe('SapRecordsService — listados', () => {
  it('lista con paginación estándar y Decimal → number', async () => {
    const { service, prisma } = makeService();
    prisma.sap_purchase_orders.count.mockResolvedValueOnce(41);
    const result = await service.listPurchaseOrders({ page: 2, limit: 20 });
    expect(result.meta).toEqual({
      total: 41,
      page: 2,
      limit: 20,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });
    expect(result.data[0].doc_total).toBe(1335149.25);
    expect(result.data[0].ahorro_total).toBeNull();
    // Saldo y solicitante (Ingrid 2026-09-23): la OC no trae Requester en
    // SAP; sale de la solicitud base.
    expect(result.data[0].open_total).toBe(667574.63);
    expect(result.data[0].requester_names).toEqual(['Erín VALVERDE']);
    expect(result.data[0].created_by_name).toBe('Comprador Uno');
    const args = (
      prisma.sap_purchase_orders.findMany.mock.calls[0] as [
        { skip: number; select: Record<string, boolean> },
      ]
    )[0];
    expect(args.skip).toBe(20);
    expect(args.select.raw).toBeUndefined(); // el raw nunca viaja en listados
  });

  it('filtros: status alias → bost_*, rango de fechas y búsqueda texto/número', async () => {
    const { service, prisma } = makeService();
    await service.listPurchaseOrders({
      status: ['open', 'cancelled'],
      from: '2026-01-01',
      to: '2026-06-30',
      search: '6121',
    });
    const where = (
      prisma.sap_purchase_orders.findMany.mock.calls[0] as [
        { where: { AND: Array<Record<string, unknown>> } },
      ]
    )[0].where;
    // A6/A5: estatus derivado multi → OR de condiciones; 'open' excluye
    // canceladas (SAP las reporta como bost_Close + Cancelled=tYES)
    expect(where.AND[0]).toEqual({
      OR: [
        { document_status: 'bost_Open', NOT: { cancelled: true } },
        { cancelled: true },
      ],
    });
    expect(where.AND[1]).toEqual({
      doc_date: {
        gte: new Date('2026-01-01'),
        lte: new Date('2026-06-30'),
      },
    });
    // búsqueda numérica agrega doc_num/doc_entry además del texto
    const or = where.AND[2].OR as Array<Record<string, unknown>>;
    expect(or).toContainEqual({ doc_num: 6121 });
    expect(or).toContainEqual({ doc_entry: 6121 });
    expect(or).toContainEqual({
      card_name: { contains: '6121', mode: 'insensitive' },
    });
    expect(or).toContainEqual({
      created_by_name: { contains: '6121', mode: 'insensitive' },
    });
  });

  it('la búsqueda encuentra OC por el solicitante de su solicitud base', async () => {
    const { service, prisma } = makeService();
    await service.listPurchaseOrders({ search: 'valverde' });
    const where = (
      prisma.sap_purchase_orders.findMany.mock.calls[0] as [
        { where: { OR: Array<Record<string, unknown>> } },
      ]
    )[0].where;
    expect(where.OR).toContainEqual({
      base_request_entries: { hasSome: [120] },
    });
  });
});

describe('SapRecordsService — detalle', () => {
  it('deriva las líneas del raw con la normalización de UDF (placeholder → null)', async () => {
    const { service, prisma } = makeService();
    const detail = await service.getPurchaseOrder(9000, false);
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[0].clasGts).toBeNull(); // "SELECCIONAR" = sin dato
    expect(detail.lines[0].procComp).toBeNull();
    expect(detail.lines[1].clasGts).toBe('OPEX');
    expect(detail.lines[1].impAhorro).toBe(50);
    // Pendiente de la línea: bruto × cantidad abierta / cantidad
    expect(detail.lines[0].openTotal).toBe(46.4);
    expect(detail.lines[0].lineStatus).toBe('open');
    expect(detail.document.requester_names).toEqual(['Erín VALVERDE']);
    expect(detail.raw).toBeUndefined(); // no-admin: sin raw
    // La fuga clásica: el raw colado DENTRO de document vía spread del row.
    // El select explícito + destructuring lo impiden — pinzado aquí.
    expect(
      (detail.document as unknown as Record<string, unknown>).raw,
    ).toBeUndefined();
    const select = (
      prisma.sap_purchase_orders.findFirst.mock.calls[0] as [
        { select: Record<string, boolean> },
      ]
    )[0].select;
    expect(select.raw).toBe(true);
    expect(select.raw_hash).toBeUndefined(); // nunca se lee ni viaja
    expect(select.mapper_version).toBeUndefined();
  });

  it('incluye raw SOLO para admins (y solo al nivel superior); DocEntry inexistente → 404', async () => {
    const { service, prisma } = makeService();
    const detail = await service.getPurchaseOrder(9000, true);
    expect(detail.raw).toBeDefined();
    expect(
      (detail.document as unknown as Record<string, unknown>).raw,
    ).toBeUndefined();

    prisma.sap_purchase_orders.findFirst.mockResolvedValueOnce(null);
    await expect(service.getPurchaseOrder(1, false)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('SapRecordsService — solicitante de OC creadas desde Maximo', () => {
  it('toma el REQUESTEDBY de la OC de Maximo (NumAtCard = PONUM)', async () => {
    const { service, prisma } = makeService();
    prisma.sap_purchase_orders.findMany.mockResolvedValueOnce([
      { ...PO_ROW, base_request_entries: [], maximo_ponum: 'PO104910' },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([
      { ponum: 'PO104910', requested_by: 'JPEREZ' },
    ]);
    const result = await service.listPurchaseOrders({});
    expect(result.data[0].requester_names).toEqual([]);
    expect(result.data[0].maximo_requested_by).toBe('JPEREZ');
  });
});

describe('SapRecordsService — importes en la moneda del documento', () => {
  it('OC en USD: las líneas usan RowTotalFC/GrossTotalFC, no LineTotal (MXN)', async () => {
    const { service, prisma } = makeService();
    prisma.sap_purchase_orders.findFirst.mockResolvedValueOnce({
      ...PO_ROW,
      currency: 'USD',
      raw: {
        DocEntry: 5415,
        DocCurrency: 'USD',
        DocumentLines: [
          {
            LineNum: 0,
            LineTotal: 363388.35,
            RowTotalFC: 19500,
            GrossTotal: 421530.49,
            GrossTotalFC: 22620,
            Quantity: 19500,
            RemainingOpenQuantity: 4500,
            LineStatus: 'bost_Open',
            Currency: 'USD',
          },
        ],
      },
    });
    const detail = await service.getPurchaseOrder(5415, false);
    expect(detail.lines[0].lineTotal).toBe(19500);
    expect(detail.lines[0].currency).toBe('USD');
    expect(detail.lines[0].openTotal).toBe(5220);
  });
});

describe('SapRecordsService — resumen', () => {
  it('agrega por estatus DERIVADO y monto POR MONEDA en SQL; expone syncEnabled', async () => {
    const { service, prisma } = makeService();
    // Orden de las consultas de entitySummary (Promise.all): byStatus,
    // byCurrency, openByCurrency, agg, gestion — primero OC, luego PR.
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { document_status: 'bost_Open', cancelled: false, count: 3 },
        { document_status: 'bost_Close', cancelled: false, count: 5 },
        { document_status: 'bost_Close', cancelled: true, count: 2 },
      ])
      .mockResolvedValueOnce([
        { currency: 'MXN', total: '5000.50', count: 7 },
        { currency: 'USD', total: '100', count: 1 },
      ])
      .mockResolvedValueOnce([{ currency: 'MXN', total: '1000', count: 3 }])
      .mockResolvedValueOnce([
        {
          total: 10,
          monto: '5100.50',
          lines_total: 30,
          lines_classified: 4,
          con_ahorro: 2,
        },
      ])
      .mockResolvedValueOnce([{ dias: '12.34' }])
      // purchase_requests: vacío
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          total: 0,
          monto: 0,
          lines_total: 0,
          lines_classified: 0,
          con_ahorro: 0,
        },
      ])
      .mockResolvedValueOnce([{ dias: null }]);
    const summary = await service.getSummary();
    expect(summary.syncEnabled).toBe(true);
    expect(summary.purchaseOrders.total).toBe(10);
    // cancelled=true manda sobre bost_Close → tercer estatus
    expect(summary.purchaseOrders.byStatus).toEqual([
      { status: 'close', count: 5 },
      { status: 'open', count: 3 },
      { status: 'cancelled', count: 2 },
    ]);
    // nunca se suma MXN con USD en una sola cifra
    expect(summary.purchaseOrders.montoPorMoneda).toEqual([
      { currency: 'MXN', total: 5000.5, count: 7 },
      { currency: 'USD', total: 100, count: 1 },
    ]);
    expect(summary.purchaseOrders.abiertas).toEqual({
      count: 3,
      montoPorMoneda: [{ currency: 'MXN', total: 1000, count: 3 }],
    });
    expect(summary.purchaseOrders.linesTotal).toBe(30);
    expect(summary.purchaseOrders.linesClassified).toBe(4);
    expect(summary.purchaseOrders.docsConAhorro).toBe(2);
    expect(summary.purchaseOrders.diasPromedioGestion).toBe(12.3);
    // entidad vacía: ceros, listas vacías y días null (nunca 0)
    expect(summary.purchaseRequests.total).toBe(0);
    expect(summary.purchaseRequests.byStatus).toEqual([]);
    expect(summary.purchaseRequests.diasPromedioGestion).toBeNull();
    expect(summary.approvalRequests).toEqual({ total: 0, pending: 0 });
    expect(summary.lastSync.purchase_orders).toBeNull();
  });
});
