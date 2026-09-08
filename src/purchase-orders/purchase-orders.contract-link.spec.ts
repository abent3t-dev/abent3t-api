import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BusinessDaysService } from '../common/services/business-days.service';
import { PurchaseOrdersService } from './purchase-orders.service';

/**
 * Fase §15/A3 — Vínculo PO→contrato: la validación que antes descartaba
 * `contract_id` ahora lo exige cuando purchase_types.requires_contract=true
 * y lo persiste. Prisma simulado, cero BD.
 */

function makeService(options: {
  requiresContract: boolean;
  contract?: { status: string; contract_number: string } | null;
}) {
  const prisma = {
    requisitions: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'rq-1',
        status: 'aprobada',
        rq_number: 'RQ001',
        expense_type: 'OPEX',
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    suppliers: {
      findFirst: jest.fn().mockResolvedValue({ id: 's-1', is_blocked: false }),
    },
    purchase_types: {
      findFirst: jest.fn().mockResolvedValue({
        requires_contract: options.requiresContract,
      }),
    },
    contracts: {
      findFirst: jest.fn().mockResolvedValue(options.contract ?? null),
    },
    purchase_orders: {
      findFirst: jest.fn().mockResolvedValue(null), // generatePoNumber
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: unknown }) =>
          Promise.resolve({ ...(data as Record<string, unknown>), id: 'po-1' }),
        ),
    },
  };
  const service = new PurchaseOrdersService(
    prisma as unknown as PrismaService,
    {} as BusinessDaysService,
  );
  return { service, prisma };
}

const DTO = {
  requisition_id: 'rq-1',
  supplier_id: 's-1',
  purchase_type_id: 'pt-1',
  amount: 100,
  currency: 'MXN',
  expected_delivery_date: '2026-10-01',
};

describe('PurchaseOrdersService — vínculo con contrato (§15/A3)', () => {
  it('tipo con requires_contract=true SIN contrato → BadRequest con mensaje claro', async () => {
    const { service, prisma } = makeService({ requiresContract: true });
    await expect(service.create(DTO, 'u-1')).rejects.toThrow(
      'requiere un contrato vigente',
    );
    expect(prisma.purchase_orders.create).not.toHaveBeenCalled();
  });

  it('contrato inexistente → NotFound; contrato no vigente → BadRequest', async () => {
    const missing = makeService({ requiresContract: true, contract: null });
    await expect(
      missing.service.create({ ...DTO, contract_id: 'ct-x' }, 'u-1'),
    ).rejects.toThrow(NotFoundException);

    const expired = makeService({
      requiresContract: true,
      contract: { status: 'vencido', contract_number: 'A3T001' },
    });
    await expect(
      expired.service.create({ ...DTO, contract_id: 'ct-1' }, 'u-1'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      expired.service.create({ ...DTO, contract_id: 'ct-1' }, 'u-1'),
    ).rejects.toThrow('no está vigente');
  });

  it('con contrato vigente → se crea y PERSISTE contract_id (y currency no llega a Prisma)', async () => {
    const { service, prisma } = makeService({
      requiresContract: true,
      contract: { status: 'vigente', contract_number: 'A3T001' },
    });
    await service.create({ ...DTO, contract_id: 'ct-1' }, 'u-1');
    expect(prisma.purchase_orders.create).toHaveBeenCalledTimes(1);
    const firstCall = prisma.purchase_orders.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    const { data } = firstCall[0];
    expect(data.contract_id).toBe('ct-1');
    expect('currency' in data).toBe(false);
  });

  it('tipo sin requires_contract y sin contrato → flujo normal intacto', async () => {
    const { service, prisma } = makeService({ requiresContract: false });
    await service.create(DTO, 'u-1');
    expect(prisma.contracts.findFirst).not.toHaveBeenCalled();
    expect(prisma.purchase_orders.create).toHaveBeenCalledTimes(1);
  });
});
