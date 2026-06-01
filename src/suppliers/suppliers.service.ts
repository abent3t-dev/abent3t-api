import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCrudPrismaService } from '../common/services/base-crud-prisma.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class SuppliersService extends BaseCrudPrismaService<
  CreateSupplierDto,
  UpdateSupplierDto
> {
  protected get model() {
    return this.prisma.suppliers;
  }
  protected readonly orderField = 'legal_name';
  protected readonly searchFields = [
    'legal_name',
    'commercial_name',
    'tax_id',
    'email',
  ];
  private readonly logger = new Logger(SuppliersService.name);

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async findAllFiltered(
    pagination: PaginationDto,
    filters?: { is_blocked?: boolean; min_score?: number },
  ) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.suppliersWhereInput = { is_active: true };
    if (filters?.is_blocked !== undefined)
      where.is_blocked = filters.is_blocked;
    if (filters?.min_score !== undefined)
      where.performance_score = { gte: filters.min_score };

    const term = pagination.search?.trim();
    if (term) {
      where.OR = this.searchFields.map((f) => ({
        [f]: { contains: term, mode: 'insensitive' },
      })) as Prisma.suppliersWhereInput['OR'];
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.suppliers.findMany({
        where,
        orderBy: { legal_name: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.suppliers.count({ where }),
    ]);

    return {
      data,
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

  async getPerformance(supplierId: string) {
    const supplier = await this.findOne(supplierId);

    const pos = await this.prisma.purchase_orders.findMany({
      where: { supplier_id: supplierId, is_active: true },
      select: {
        id: true,
        status: true,
        expected_delivery_date: true,
        actual_delivery_date: true,
        amount: true,
      },
    });

    const totalOrders = pos.length;
    const deliveredOrders = pos.filter(
      (po) => po.status === 'entregada_completa',
    );
    const onTimeDeliveries = deliveredOrders.filter(
      (po) =>
        po.actual_delivery_date &&
        po.expected_delivery_date &&
        new Date(po.actual_delivery_date) <= new Date(po.expected_delivery_date),
    );

    const totalAmount = pos.reduce(
      (sum, po) => sum + Number(po.amount ?? 0),
      0,
    );

    return {
      supplier_id: supplierId,
      supplier_name: supplier.legal_name,
      performance_score: Number(supplier.performance_score) || 0,
      total_orders: totalOrders,
      delivered_orders: deliveredOrders.length,
      on_time_delivery_rate:
        deliveredOrders.length > 0
          ? Math.round(
              (onTimeDeliveries.length / deliveredOrders.length) * 100,
            )
          : 0,
      total_amount: totalAmount,
      is_blocked: supplier.is_blocked,
    };
  }

  async getPurchaseOrders(supplierId: string, pagination: PaginationDto) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const skip = (page - 1) * limit;
    const where = { supplier_id: supplierId, is_active: true };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.purchase_orders.findMany({
        where,
        include: {
          requisitions: { select: { rq_number: true, description: true } },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.purchase_orders.count({ where }),
    ]);

    return {
      data,
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

  async evaluate(supplierId: string, score: number, userId: string) {
    if (score < 0 || score > 100) {
      throw new BadRequestException('El puntaje debe estar entre 0 y 100');
    }
    const data = await this.prisma.suppliers.update({
      where: { id: supplierId },
      data: { performance_score: score },
    });
    this.logger.log(
      `Proveedor ${supplierId} evaluado con puntaje ${score} por usuario ${userId}`,
    );
    return data;
  }

  async block(supplierId: string, reason: string, userId: string) {
    const data = await this.prisma.suppliers.update({
      where: { id: supplierId },
      data: {
        is_blocked: true,
        blocked_reason: reason,
        blocked_at: new Date(),
        blocked_by: userId,
      },
    });
    this.logger.warn(
      `Proveedor ${supplierId} bloqueado por usuario ${userId}. Razón: ${reason}`,
    );
    return data;
  }

  async unblock(supplierId: string, userId: string) {
    const data = await this.prisma.suppliers.update({
      where: { id: supplierId },
      data: {
        is_blocked: false,
        blocked_reason: null,
        blocked_at: null,
        blocked_by: null,
      },
    });
    this.logger.log(`Proveedor ${supplierId} desbloqueado por usuario ${userId}`);
    return data;
  }

  async create(dto: CreateSupplierDto) {
    const existing = await this.prisma.suppliers.findFirst({
      where: { tax_id: dto.tax_id },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(
        `Ya existe un proveedor con el RFC ${dto.tax_id}`,
      );
    }
    return super.create(dto);
  }
}
