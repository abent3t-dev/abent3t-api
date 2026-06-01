import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BusinessDaysService } from '../common/services/business-days.service';
import { CreateRequisitionDto } from './dto/create-requisition.dto';
import { UpdateRequisitionDto } from './dto/update-requisition.dto';
import { FilterRequisitionDto } from './dto/filter-requisition.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

// Estados validos de requisicion (segun DB enum). NOTA: 'borrador' NO existe
// en BD real (§K-3 del AUDIT) — el flujo empieza en 'en_revision'.
export type RequisitionStatus =
  | 'en_revision'
  | 'en_aprobacion'
  | 'aprobada'
  | 'en_progreso'
  | 'cerrada'
  | 'cancelada';

const VALID_TRANSITIONS: Record<RequisitionStatus, RequisitionStatus[]> = {
  en_revision: ['en_aprobacion', 'cancelada'],
  en_aprobacion: ['aprobada', 'cancelada'],
  aprobada: ['en_progreso', 'cancelada'],
  en_progreso: ['cerrada', 'cancelada'],
  cerrada: [],
  cancelada: [],
};

const REQUISITION_INCLUDE = {
  profiles_requisitions_requester_idToprofiles: {
    select: { id: true, full_name: true, email: true },
  },
  profiles_requisitions_buyer_idToprofiles: {
    select: { id: true, full_name: true, email: true },
  },
  departments: { select: { id: true, name: true } },
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aliasRequisition<T extends Record<string, any>>(row: T): T {
  if (!row) return row;
  return {
    ...row,
    requester: row.profiles_requisitions_requester_idToprofiles ?? null,
    buyer: row.profiles_requisitions_buyer_idToprofiles ?? null,
    department: row.departments ?? null,
  };
}

@Injectable()
export class RequisitionsService {
  private readonly logger = new Logger(RequisitionsService.name);

  /** Lock simple para generación de rq_number (single-process). */
  private rqNumberLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly businessDays: BusinessDaysService,
  ) {}

  async findAll(pagination: PaginationDto, filters?: FilterRequisitionDto) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.requisitionsWhereInput = { is_active: true };
    if (filters?.status)
      where.status = filters.status as Prisma.requisitionsWhereInput['status'];
    if (filters?.expense_type)
      where.expense_type = filters.expense_type as Prisma.requisitionsWhereInput['expense_type'];
    if (filters?.buyer_id) where.buyer_id = filters.buyer_id;
    if (filters?.requester_id) where.requester_id = filters.requester_id;
    if (filters?.department_id) where.department_id = filters.department_id;
    if (filters?.source) where.source = filters.source;
    if (filters?.date_from || filters?.date_to) {
      const range: Prisma.DateTimeFilter = {};
      if (filters.date_from) range.gte = new Date(filters.date_from);
      if (filters.date_to) range.lte = new Date(filters.date_to);
      where.created_date = range;
    }

    const term = pagination.search?.trim();
    if (term) {
      where.OR = [
        { rq_number: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.requisitions.findMany({
        where,
        include: REQUISITION_INCLUDE,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.requisitions.count({ where }),
    ]);

    return {
      data: data.map((r) => aliasRequisition(r as unknown as Record<string, unknown>)),
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

  async getStats(filters?: { date_from?: string; date_to?: string }) {
    const where: Prisma.requisitionsWhereInput = { is_active: true };
    if (filters?.date_from || filters?.date_to) {
      const range: Prisma.DateTimeFilter = {};
      if (filters.date_from) range.gte = new Date(filters.date_from);
      if (filters.date_to) range.lte = new Date(filters.date_to);
      where.created_date = range;
    }

    const data = await this.prisma.requisitions.findMany({
      where,
      select: {
        status: true,
        expense_type: true,
        business_days_elapsed: true,
        estimated_amount: true,
      },
    });

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let totalDays = 0;
    let closedCount = 0;
    let totalAmount = 0;

    for (const rq of data) {
      const status = rq.status ?? 'unknown';
      byStatus[status] = (byStatus[status] || 0) + 1;
      if (rq.expense_type)
        byType[rq.expense_type] = (byType[rq.expense_type] || 0) + 1;
      totalAmount += Number(rq.estimated_amount ?? 0);
      if (status === 'cerrada' && rq.business_days_elapsed) {
        totalDays += rq.business_days_elapsed;
        closedCount++;
      }
    }

    return {
      total: data.length,
      by_status: byStatus,
      by_type: byType,
      total_estimated_amount: totalAmount,
      average_business_days:
        closedCount > 0 ? Math.round(totalDays / closedCount) : 0,
    };
  }

  async findOne(id: string) {
    const data = await this.prisma.requisitions.findUnique({
      where: { id },
      include: REQUISITION_INCLUDE,
    });
    if (!data) throw new NotFoundException('Requisición no encontrada');
    return aliasRequisition(data as unknown as Record<string, unknown>);
  }

  async getHistory(requisitionId: string) {
    return this.prisma.requisition_history.findMany({
      where: { requisition_id: requisitionId },
      include: {
        profiles: { select: { id: true, full_name: true } },
      },
      orderBy: { changed_at: 'desc' },
    });
  }

  /**
   * Genera el siguiente rq_number (reemplaza el trigger
   * `auto_generate_rq_number` — §K-4). Patrón: `RQ-YYYY-NNNNNN`
   * (año + secuencia anual de 6 dígitos zero-padded).
   *
   * Serializado por `rqNumberLock` para evitar race conditions en single
   * process. En multi-instancia hay que migrar a una sequence o advisory
   * lock — para dev local es suficiente.
   */
  private async generateRqNumber(): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `RQ-${year}-`;

    // Lock simple por proceso
    const release = this.rqNumberLock;
    let resolveNext: () => void = () => {};
    this.rqNumberLock = new Promise<void>((r) => {
      resolveNext = r;
    });
    await release;

    try {
      const last = await this.prisma.requisitions.findFirst({
        where: { rq_number: { startsWith: prefix } },
        orderBy: { rq_number: 'desc' },
        select: { rq_number: true },
      });
      let next = 1;
      if (last?.rq_number) {
        const seq = parseInt(last.rq_number.slice(prefix.length), 10);
        if (!isNaN(seq)) next = seq + 1;
      }
      return prefix + String(next).padStart(6, '0');
    } finally {
      resolveNext();
    }
  }

  async create(dto: CreateRequisitionDto, userId: string) {
    await this.validateFK(this.prisma.profiles, dto.requester_id, 'requester_id');
    if (dto.buyer_id)
      await this.validateFK(this.prisma.profiles, dto.buyer_id, 'buyer_id');
    if (dto.department_id)
      await this.validateFK(
        this.prisma.departments,
        dto.department_id,
        'department_id',
      );

    const rqNumber = await this.generateRqNumber();

    const created = await this.prisma.requisitions.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: {
        ...dto,
        rq_number: rqNumber,
        status: 'en_revision',
      } as any,
      include: REQUISITION_INCLUDE,
    });

    this.logger.log(
      `Requisición ${created.rq_number} creada por usuario ${userId}`,
    );
    return aliasRequisition(created as unknown as Record<string, unknown>);
  }

  async update(id: string, dto: UpdateRequisitionDto, userId: string) {
    const existing = await this.findOne(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e: any = existing;
    if (['cerrada', 'cancelada'].includes(e.status)) {
      throw new BadRequestException(
        `No se puede actualizar una requisición con estado ${e.status}`,
      );
    }

    const updated = await this.prisma.requisitions.update({
      where: { id },
      data: dto as Prisma.requisitionsUpdateInput,
      include: REQUISITION_INCLUDE,
    });

    await this.logHistory(
      id,
      'general_update',
      JSON.stringify(existing),
      JSON.stringify(dto),
      userId,
    );

    return aliasRequisition(updated as unknown as Record<string, unknown>);
  }

  async changeStatus(
    id: string,
    newStatus: RequisitionStatus,
    userId: string,
  ) {
    const existing = await this.findOne(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e: any = existing;
    const currentStatus = e.status as RequisitionStatus;

    if (!VALID_TRANSITIONS[currentStatus]?.includes(newStatus)) {
      throw new BadRequestException(
        `Transición de estado no permitida: ${currentStatus} -> ${newStatus}`,
      );
    }

    const updateData: Prisma.requisitionsUpdateInput = {
      status: newStatus as Prisma.requisitionsUpdateInput['status'],
    };

    if (newStatus === 'cerrada') {
      const today = new Date();
      updateData.closed_date = today;
      updateData.business_days_elapsed = await this.businessDays.calculate(
        e.created_date,
        today,
      );
    }

    const updated = await this.prisma.requisitions.update({
      where: { id },
      data: updateData,
      include: REQUISITION_INCLUDE,
    });

    await this.logHistory(id, 'status', currentStatus, newStatus, userId);
    this.logger.log(
      `Requisición ${e.rq_number} cambió de ${currentStatus} a ${newStatus}`,
    );

    return aliasRequisition(updated as unknown as Record<string, unknown>);
  }

  async assignBuyer(id: string, buyerId: string, userId: string) {
    const existing = await this.findOne(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e: any = existing;

    await this.validateFK(this.prisma.profiles, buyerId, 'buyer_id');

    const updated = await this.prisma.requisitions.update({
      where: { id },
      data: { buyer_id: buyerId },
      include: REQUISITION_INCLUDE,
    });

    await this.logHistory(id, 'buyer_id', e.buyer_id ?? null, buyerId, userId);
    this.logger.log(
      `Requisición ${e.rq_number} asignada a comprador ${buyerId}`,
    );

    return aliasRequisition(updated as unknown as Record<string, unknown>);
  }

  async cancel(id: string, userId: string) {
    return this.changeStatus(id, 'cancelada', userId);
  }

  /**
   * Registra un cambio en el historial (reemplaza el trigger
   * `log_requisition_changes` — §K-4). No bloquea la operación principal.
   */
  private async logHistory(
    requisitionId: string,
    fieldChanged: string,
    oldValue: string | null,
    newValue: string,
    changedBy: string,
  ) {
    try {
      await this.prisma.requisition_history.create({
        data: {
          requisition_id: requisitionId,
          field_changed: fieldChanged,
          old_value: oldValue,
          new_value: newValue,
          changed_by: changedBy,
        },
      });
    } catch (err) {
      this.logger.error('Error registrando historial:', err);
    }
  }

  private async validateFK(
    delegate: { findUnique: (args: unknown) => Promise<unknown> },
    id: string,
    fieldName: string,
  ): Promise<void> {
    const row = (await delegate.findUnique({
      where: { id },
      select: { id: true, is_active: true },
    } as unknown)) as { id: string; is_active?: boolean } | null;

    if (!row) {
      throw new BadRequestException(`${fieldName}: registro no encontrado`);
    }
    if (row.is_active === false) {
      throw new BadRequestException(
        `${fieldName}: el registro está desactivado`,
      );
    }
  }

  async importFromExternal(
    requisitions: CreateRequisitionDto[],
    source: 'maximo' | 'sap',
    userId: string,
  ) {
    const results = {
      imported: 0,
      failed: 0,
      errors: [] as string[],
    };

    for (const rq of requisitions) {
      try {
        if (rq.external_id) {
          const existing = await this.prisma.requisitions.findFirst({
            where: { external_id: rq.external_id, source },
            select: { id: true },
          });
          if (existing) {
            results.errors.push(
              `RQ ${rq.external_id} ya existe en el sistema`,
            );
            results.failed++;
            continue;
          }
        }

        await this.create({ ...rq, source }, userId);
        results.imported++;
      } catch (error: unknown) {
        results.failed++;
        const msg = (error as { message?: string })?.message ?? 'unknown';
        results.errors.push(`Error importando RQ: ${msg}`);
      }
    }

    this.logger.log(
      `Importación desde ${source}: ${results.imported} exitosas, ${results.failed} fallidas`,
    );
    return results;
  }
}
