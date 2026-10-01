import { PrismaService } from '../prisma/prisma.service';
import { SuppliersService, supplierSapState } from './suppliers.service';

/**
 * I5 (go-live 2026-09-30) — "¿Ninguno inactivo?": el estado EN SAP
 * (congelado o no válido = inactivo) se muestra, se cuenta y se filtra sin
 * tocar `is_active`, que es la baja dentro de la plataforma.
 */

describe('supplierSapState (I5)', () => {
  it('congelado o no válido = inactivo en SAP; los de ABENT no tienen estado en SAP', () => {
    expect(
      supplierSapState({ source: 'sap', sap_valid: false, sap_frozen: true }),
    ).toBe('inactivo');
    expect(
      supplierSapState({ source: 'sap', sap_valid: true, sap_frozen: true }),
    ).toBe('inactivo');
    expect(
      supplierSapState({ source: 'sap', sap_valid: true, sap_frozen: false }),
    ).toBe('activo');
    expect(
      supplierSapState({ source: 'sap', sap_valid: null, sap_frozen: null }),
    ).toBe('activo');
    expect(
      supplierSapState({ source: 'manual', sap_valid: null, sap_frozen: null }),
    ).toBeNull();
  });
});

describe('SuppliersService — estado en SAP (I5)', () => {
  function makeService() {
    const prisma = {
      suppliers: {
        groupBy: jest.fn().mockResolvedValue([
          {
            source: 'sap',
            sap_valid: true,
            sap_frozen: false,
            _count: { _all: 474 },
          },
          {
            source: 'sap',
            sap_valid: false,
            sap_frozen: true,
            _count: { _all: 401 },
          },
          {
            source: 'manual',
            sap_valid: null,
            sap_frozen: null,
            _count: { _all: 35 },
          },
        ]),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
    };
    const service = new SuppliersService(prisma as unknown as PrismaService);
    return { service, prisma };
  }

  it('contadores: activos e inactivos en SAP, sin tocar is_active', async () => {
    const { service, prisma } = makeService();
    await expect(service.sapCounts()).resolves.toEqual({
      activos: 474,
      inactivos: 401,
      sin_sap: 35,
    });
    expect(prisma.suppliers.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { is_active: true } }),
    );
  });

  it('filtro sap_estado: inactivo = congelado o no válido; activo = ni uno ni otro', async () => {
    const { service, prisma } = makeService();
    await service.findAllFiltered(
      { page: 1, limit: 20 },
      { sap_estado: 'inactivo' },
    );
    const inactive = (
      prisma.suppliers.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(inactive).toMatchObject({
      is_active: true,
      source: 'sap',
      AND: [{ OR: [{ sap_valid: false }, { sap_frozen: true }] }],
    });

    await service.findAllFiltered(
      { page: 1, limit: 20 },
      { sap_estado: 'activo' },
    );
    const active = (
      prisma.suppliers.findMany.mock.calls[1] as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(active).toMatchObject({
      is_active: true,
      source: 'sap',
      AND: [
        { OR: [{ sap_valid: null }, { sap_valid: true }] },
        { OR: [{ sap_frozen: null }, { sap_frozen: false }] },
      ],
    });
  });
});
