import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
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
  last_changed_at: null,
  last_seen_at: new Date(),
  raw: {
    DocEntry: 9000,
    DocumentLines: [
      {
        LineNum: 0,
        ItemCode: 'A1',
        ItemDescription: 'Empaque',
        LineTotal: 100,
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
      findMany: jest.fn().mockResolvedValue([]),
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
  const service = new SapRecordsService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
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
      status: 'open',
      from: '2026-01-01',
      to: '2026-06-30',
      search: '6121',
    });
    const where = (
      prisma.sap_purchase_orders.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(where.document_status).toBe('bost_Open');
    expect(where.doc_date).toEqual({
      gte: new Date('2026-01-01'),
      lte: new Date('2026-06-30'),
    });
    // búsqueda numérica agrega doc_num/doc_entry además del texto
    const or = where.OR as Array<Record<string, unknown>>;
    expect(or).toContainEqual({ doc_num: 6121 });
    expect(or).toContainEqual({ doc_entry: 6121 });
    expect(or).toContainEqual({
      card_name: { contains: '6121', mode: 'insensitive' },
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

describe('SapRecordsService — resumen', () => {
  it('agrega por estatus, suma montos/líneas y expone syncEnabled', async () => {
    const { service } = makeService();
    const summary = await service.getSummary();
    expect(summary.syncEnabled).toBe(true);
    expect(summary.purchaseOrders.total).toBe(10);
    expect(summary.purchaseOrders.byStatus[0]).toEqual({
      status: 'bost_Close',
      count: 7,
    });
    expect(summary.purchaseOrders.montoTotal).toBe(5000.5);
    expect(summary.purchaseOrders.linesTotal).toBe(30);
    expect(summary.purchaseOrders.linesClassified).toBe(4);
    expect(summary.purchaseOrders.docsConAhorro).toBe(2);
    // entidad vacía: ceros y byStatus vacío, sin nulls raros
    expect(summary.purchaseRequests.total).toBe(0);
    expect(summary.purchaseRequests.montoTotal).toBe(0);
    expect(summary.lastSync.purchase_orders).toBeNull();
  });
});
