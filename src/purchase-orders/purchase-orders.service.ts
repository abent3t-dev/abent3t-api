import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BusinessDaysService } from '../common/services/business-days.service';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

export type POStatus =
  | 'emitida'
  | 'en_transito'
  | 'entregada_parcial'
  | 'entregada_completa'
  | 'cancelada';

const VALID_TRANSITIONS: Record<POStatus, POStatus[]> = {
  emitida: ['en_transito', 'cancelada'],
  en_transito: ['entregada_parcial', 'entregada_completa', 'cancelada'],
  entregada_parcial: ['entregada_completa', 'cancelada'],
  entregada_completa: [],
  cancelada: [],
};

const PO_INCLUDE = {
  requisitions: {
    select: {
      id: true,
      rq_number: true,
      description: true,
      expense_type: true,
      requester_id: true,
    },
  },
  suppliers: {
    select: {
      id: true,
      legal_name: true,
      commercial_name: true,
      tax_id: true,
      email: true,
    },
  },
  profiles: { select: { id: true, full_name: true } },
  purchase_types: { select: { id: true, name: true, key: true } },
  contracts: {
    select: { id: true, contract_number: true, status: true },
  },
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aliasPO<T extends Record<string, any>>(row: T): T {
  if (!row) return row;
  return {
    ...row,
    requisition: row.requisitions ?? null,
    supplier: row.suppliers ?? null,
    buyer: row.profiles ?? null,
    purchase_type: row.purchase_types ?? null,
    contract: row.contracts ?? null,
  };
}

@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);
  private poNumberLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly businessDays: BusinessDaysService,
  ) {}

  async findAll(
    pagination: PaginationDto,
    filters?: {
      status?: POStatus;
      supplier_id?: string;
      purchase_type_id?: string;
      expense_type?: string;
      date_from?: string;
      date_to?: string;
    },
  ) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.purchase_ordersWhereInput = { is_active: true };
    if (filters?.status)
      where.status =
        filters.status as Prisma.purchase_ordersWhereInput['status'];
    if (filters?.supplier_id) where.supplier_id = filters.supplier_id;
    if (filters?.purchase_type_id)
      where.purchase_type_id = filters.purchase_type_id;
    if (filters?.expense_type)
      where.expense_type =
        filters.expense_type as Prisma.purchase_ordersWhereInput['expense_type'];
    if (filters?.date_from || filters?.date_to) {
      const range: Prisma.DateTimeNullableFilter = {};
      if (filters.date_from) range.gte = new Date(filters.date_from);
      if (filters.date_to) range.lte = new Date(filters.date_to);
      where.created_at = range;
    }

    const term = pagination.search?.trim();
    if (term) {
      where.po_number = { contains: term, mode: 'insensitive' };
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.purchase_orders.findMany({
        where,
        include: PO_INCLUDE,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.purchase_orders.count({ where }),
    ]);

    return {
      data: data.map((p) => aliasPO(p as unknown as Record<string, unknown>)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  async findOne(id: string) {
    const data = await this.prisma.purchase_orders.findUnique({
      where: { id },
      include: PO_INCLUDE,
    });
    if (!data) throw new NotFoundException('Orden de compra no encontrada');
    return aliasPO(data as unknown as Record<string, unknown>);
  }

  async findByRequisition(requisitionId: string) {
    const data = await this.prisma.purchase_orders.findMany({
      where: { requisition_id: requisitionId, is_active: true },
      include: PO_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    return data.map((p) => aliasPO(p as unknown as Record<string, unknown>));
  }

  /**
   * Genera el siguiente po_number (reemplaza el trigger
   * `auto_generate_po_number` — §K-4). Patrón: `PO-YYYY-NNNNNN`.
   */
  private async generatePoNumber(): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `PO-${year}-`;

    const release = this.poNumberLock;
    let resolveNext: () => void = () => {};
    this.poNumberLock = new Promise<void>((r) => {
      resolveNext = r;
    });
    await release;

    try {
      const last = await this.prisma.purchase_orders.findFirst({
        where: { po_number: { startsWith: prefix } },
        orderBy: { po_number: 'desc' },
        select: { po_number: true },
      });
      let next = 1;
      if (last?.po_number) {
        const seq = parseInt(last.po_number.slice(prefix.length), 10);
        if (!isNaN(seq)) next = seq + 1;
      }
      return prefix + String(next).padStart(6, '0');
    } finally {
      resolveNext();
    }
  }

  /**
   * §15/A3 — Valida el vínculo PO→contrato: obligatorio cuando
   * `purchase_types.requires_contract` es true; si se envía, el contrato
   * debe existir, estar activo y en estatus `vigente`.
   */
  private async assertContractLink(
    contractId: string | null | undefined,
    requiresContract: boolean,
  ): Promise<void> {
    if (!contractId) {
      if (requiresContract) {
        throw new BadRequestException(
          'Este tipo de compra requiere un contrato vigente: selecciona uno antes de continuar',
        );
      }
      return;
    }
    const contract = await this.prisma.contracts.findFirst({
      where: { id: contractId, is_active: true },
      select: { status: true, contract_number: true },
    });
    if (!contract) throw new NotFoundException('Contrato no encontrado');
    if (contract.status !== 'vigente') {
      throw new BadRequestException(
        `El contrato ${contract.contract_number} no está vigente (estatus: ${contract.status})`,
      );
    }
  }

  async create(dto: CreatePurchaseOrderDto, userId: string) {
    const requisition = await this.prisma.requisitions.findFirst({
      where: { id: dto.requisition_id, is_active: true },
    });
    if (!requisition) {
      throw new NotFoundException('Requisición no encontrada');
    }
    if (requisition.status !== 'aprobada') {
      throw new BadRequestException(
        'Solo se pueden crear POs desde requisiciones aprobadas',
      );
    }

    const supplier = await this.prisma.suppliers.findFirst({
      where: { id: dto.supplier_id, is_active: true },
    });
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    if (supplier.is_blocked) {
      throw new BadRequestException(
        'El proveedor está bloqueado y no puede recibir órdenes de compra',
      );
    }

    // Vínculo con contrato (§15/A3): cuando el tipo de compra lo exige, la
    // PO debe traer un contrato existente y vigente; si viene sin exigirse,
    // igual se valida antes de persistir.
    let requiresContract = false;
    if (dto.purchase_type_id) {
      const purchaseType = await this.prisma.purchase_types.findFirst({
        where: { id: dto.purchase_type_id, is_active: true },
        select: { requires_contract: true },
      });
      if (!purchaseType) {
        throw new NotFoundException('Tipo de compra no encontrado');
      }
      requiresContract = purchaseType.requires_contract ?? false;
    }
    await this.assertContractLink(dto.contract_id ?? null, requiresContract);

    const poNumber = await this.generatePoNumber();
    // `currency` viene en el DTO pero la tabla no tiene esa columna: se
    // descarta para que Prisma no rechace el create.
    const { currency: _currency, ...rest } = dto as CreatePurchaseOrderDto & {
      currency?: string;
    };

    const created = await this.prisma.purchase_orders.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: {
        ...rest,
        po_number: poNumber,
        expense_type: requisition.expense_type,
        status: 'emitida',
        buyer_id: userId,
      } as any,
      include: PO_INCLUDE,
    });

    await this.prisma.requisitions.update({
      where: { id: dto.requisition_id },
      data: { status: 'en_progreso' },
    });

    this.logger.log(
      `PO ${created.po_number} creada para requisición ${requisition.rq_number}`,
    );

    return aliasPO(created as unknown as Record<string, unknown>);
  }

  async update(id: string, dto: UpdatePurchaseOrderDto, userId: string) {
    const existing = await this.findOne(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e: any = existing;

    if (['entregada_completa', 'cancelada'].includes(e.status)) {
      throw new BadRequestException(
        `No se puede actualizar una PO con estado ${e.status}`,
      );
    }

    // Vínculo con contrato (§15/A3) sobre el estado RESULTANTE de la PO
    const current = e as {
      contract_id?: string | null;
      purchase_type_id: string;
    };
    const nextContractId =
      dto.contract_id !== undefined
        ? dto.contract_id
        : (current.contract_id ?? null);
    const nextTypeId = dto.purchase_type_id ?? current.purchase_type_id;
    const purchaseType = await this.prisma.purchase_types.findFirst({
      where: { id: nextTypeId },
      select: { requires_contract: true },
    });
    await this.assertContractLink(
      nextContractId,
      purchaseType?.requires_contract ?? false,
    );

    // `currency` no existe como columna (misma limpieza que en create)
    const { currency: _currency, ...updateData } =
      dto as UpdatePurchaseOrderDto & { currency?: string };

    const updated = await this.prisma.purchase_orders.update({
      where: { id },
      data: updateData as Prisma.purchase_ordersUpdateInput,
      include: PO_INCLUDE,
    });

    this.logger.log(`PO ${e.po_number} actualizada por usuario ${userId}`);
    return aliasPO(updated as unknown as Record<string, unknown>);
  }

  async changeStatus(
    id: string,
    newStatus: POStatus,
    userId: string,
    actualDeliveryDate?: string,
  ) {
    const existing = await this.findOne(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e: any = existing;
    const currentStatus = e.status as POStatus;

    if (!VALID_TRANSITIONS[currentStatus]?.includes(newStatus)) {
      throw new BadRequestException(
        `Transición de estado no permitida: ${currentStatus} -> ${newStatus}`,
      );
    }

    const updateData: Prisma.purchase_ordersUpdateInput = {
      status: newStatus as Prisma.purchase_ordersUpdateInput['status'],
    };
    if (['entregada_parcial', 'entregada_completa'].includes(newStatus)) {
      updateData.actual_delivery_date = actualDeliveryDate
        ? new Date(actualDeliveryDate)
        : new Date();
    }

    const updated = await this.prisma.purchase_orders.update({
      where: { id },
      data: updateData,
      include: PO_INCLUDE,
    });

    // Si la PO se entrega completamente, cerrar la requisición si todas están entregadas
    if (newStatus === 'entregada_completa') {
      const allPos = await this.prisma.purchase_orders.findMany({
        where: { requisition_id: e.requisition_id, is_active: true },
        select: { status: true },
      });
      const allDelivered = allPos.every(
        (po) => po.status === 'entregada_completa',
      );

      if (allDelivered) {
        const today = new Date();
        const rq = await this.prisma.requisitions.findUnique({
          where: { id: e.requisition_id },
          select: { created_date: true },
        });

        const businessDays = rq
          ? await this.businessDays.calculate(rq.created_date, today)
          : 0;

        await this.prisma.requisitions.update({
          where: { id: e.requisition_id },
          data: {
            status: 'cerrada',
            closed_date: today,
            business_days_elapsed: businessDays,
          },
        });
      }
    }

    this.logger.log(
      `PO ${e.po_number} cambió de ${currentStatus} a ${newStatus} (por ${userId})`,
    );

    return aliasPO(updated as unknown as Record<string, unknown>);
  }

  async cancel(id: string, userId: string) {
    return this.changeStatus(id, 'cancelada', userId);
  }

  async getStats(filters?: {
    date_from?: string;
    date_to?: string;
    expense_type?: string;
  }) {
    const where: Prisma.purchase_ordersWhereInput = { is_active: true };
    if (filters?.date_from || filters?.date_to) {
      const range: Prisma.DateTimeNullableFilter = {};
      if (filters.date_from) range.gte = new Date(filters.date_from);
      if (filters.date_to) range.lte = new Date(filters.date_to);
      where.created_at = range;
    }
    if (filters?.expense_type)
      where.expense_type =
        filters.expense_type as Prisma.purchase_ordersWhereInput['expense_type'];

    const data = await this.prisma.purchase_orders.findMany({
      where,
      select: {
        status: true,
        expense_type: true,
        purchase_type_id: true,
        amount: true,
        purchase_types: { select: { name: true } },
      },
    });

    const byStatus: Record<string, { count: number; amount: number }> = {};
    const byType: Record<string, { count: number; amount: number }> = {};
    const byPurchaseType: Record<string, { count: number; amount: number }> =
      {};
    let totalAmount = 0;

    for (const po of data) {
      const amount = Number(po.amount ?? 0);
      const status = po.status ?? 'unknown';

      if (!byStatus[status]) byStatus[status] = { count: 0, amount: 0 };
      byStatus[status].count++;
      byStatus[status].amount += amount;

      if (po.expense_type) {
        if (!byType[po.expense_type])
          byType[po.expense_type] = { count: 0, amount: 0 };
        byType[po.expense_type].count++;
        byType[po.expense_type].amount += amount;
      }

      const name = po.purchase_types?.name;
      if (name) {
        if (!byPurchaseType[name])
          byPurchaseType[name] = { count: 0, amount: 0 };
        byPurchaseType[name].count++;
        byPurchaseType[name].amount += amount;
      }

      totalAmount += amount;
    }

    return {
      total: data.length,
      total_amount: totalAmount,
      by_status: byStatus,
      by_type: byType,
      by_purchase_type: byPurchaseType,
    };
  }
}
