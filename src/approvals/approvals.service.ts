import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BusinessDaysService } from '../common/services/business-days.service';
import { SocketService } from '../socket/socket.service';

const APPROVAL_LEVELS: Record<number, string> = {
  1: 'aprobador_nivel_1',
  2: 'aprobador_nivel_2',
  3: 'aprobador_nivel_3',
  4: 'director_general',
};

const LEVEL_NAMES: Record<number, string> = {
  1: 'Nivel 1 (David)',
  2: 'Nivel 2 (Gilberto)',
  3: 'Nivel 3 (Uriel)',
  4: 'Director General',
};

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly businessDays: BusinessDaysService,
    private readonly socketService: SocketService,
  ) {}

  /** Aprobaciones pendientes del usuario actual. */
  async getPending(userId: string, userRole: string) {
    const userLevel = Object.entries(APPROVAL_LEVELS).find(
      ([, role]) => role === userRole,
    )?.[0];
    if (!userLevel) return [];

    return this.prisma.approvals.findMany({
      where: {
        approver_id: userId,
        status: 'pendiente',
        is_active: true,
      },
      include: {
        approval_workflows: {
          include: {
            requisitions: {
              include: {
                profiles_requisitions_requester_idToprofiles: {
                  select: { id: true, full_name: true, email: true },
                },
                departments: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: { created_at: 'asc' },
    });
  }

  async getMyApprovals(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where: Prisma.approvalsWhereInput = {
      approver_id: userId,
      is_active: true,
      status: { not: 'pendiente' },
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.approvals.findMany({
        where,
        include: {
          approval_workflows: {
            include: {
              requisitions: {
                select: {
                  id: true,
                  rq_number: true,
                  description: true,
                  estimated_amount: true,
                },
              },
            },
          },
        },
        orderBy: { approved_at: { sort: 'desc', nulls: 'last' } },
        skip,
        take: limit,
      }),
      this.prisma.approvals.count({ where }),
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

  async getWorkflowByRequisition(requisitionId: string) {
    const workflow = await this.prisma.approval_workflows.findFirst({
      where: { requisition_id: requisitionId, is_active: true },
    });
    if (!workflow) return null;

    const approvals = await this.prisma.approvals.findMany({
      where: { workflow_id: workflow.id, is_active: true },
      include: {
        profiles: {
          select: { id: true, full_name: true, email: true, role: true },
        },
      },
      orderBy: { level: 'asc' },
    });

    return {
      ...workflow,
      approvals: approvals.map((a) => ({
        ...a,
        approver: a.profiles,
      })),
      level_names: LEVEL_NAMES,
    };
  }

  /** Inicia el workflow de aprobación para una requisición. */
  async startWorkflow(requisitionId: string, _userId: string) {
    const requisition = await this.prisma.requisitions.findFirst({
      where: { id: requisitionId, is_active: true },
    });
    if (!requisition) {
      throw new NotFoundException('Requisición no encontrada');
    }
    if (requisition.status !== 'en_revision') {
      throw new BadRequestException(
        'Solo se puede iniciar workflow para requisiciones en revisión',
      );
    }

    const existingWorkflow = await this.prisma.approval_workflows.findFirst({
      where: { requisition_id: requisitionId, is_active: true },
      select: { id: true },
    });
    if (existingWorkflow) {
      throw new BadRequestException(
        'Ya existe un workflow de aprobación para esta requisición',
      );
    }

    const workflow = await this.prisma.approval_workflows.create({
      data: {
        requisition_id: requisitionId,
        current_level: 1,
        status: 'pendiente',
      },
    });

    for (let level = 1; level <= 4; level++) {
      const role = APPROVAL_LEVELS[level];
      const approver = await this.prisma.profiles.findFirst({
        where: {
          role: role as Prisma.profilesWhereInput['role'],
          is_active: true,
        },
        select: { id: true },
      });

      if (approver) {
        await this.prisma.approvals.create({
          data: {
            workflow_id: workflow.id,
            level,
            approver_id: approver.id,
            status: level === 1 ? 'pendiente' : 'pendiente', // todos pendientes; el actual se determina por workflow.current_level
          },
        });
      }
    }

    await this.prisma.requisitions.update({
      where: { id: requisitionId },
      data: { status: 'en_progreso' },
    });

    await this.notifyApprover(workflow.id, 1, requisition);

    this.logger.log(
      `Workflow iniciado para requisición ${requisition.rq_number}`,
    );

    return workflow;
  }

  async approve(
    requisitionId: string,
    userId: string,
    userRole: string,
    _comments?: string,
  ) {
    const userLevel = Object.entries(APPROVAL_LEVELS).find(
      ([, role]) => role === userRole,
    )?.[0];
    if (!userLevel) {
      throw new ForbiddenException(
        'No tienes permisos para aprobar requisiciones',
      );
    }

    const workflow = await this.prisma.approval_workflows.findFirst({
      where: { requisition_id: requisitionId, is_active: true },
      include: { requisitions: true },
    });
    if (!workflow) {
      throw new NotFoundException(
        'No existe workflow de aprobación para esta requisición',
      );
    }
    if (workflow.status !== 'pendiente') {
      throw new BadRequestException(`El workflow ya está ${workflow.status}`);
    }
    if (workflow.current_level !== parseInt(userLevel, 10)) {
      throw new BadRequestException(
        `Esta requisición está pendiente de aprobación en nivel ${workflow.current_level}`,
      );
    }

    const approval = await this.prisma.approvals.findFirst({
      where: {
        workflow_id: workflow.id,
        level: workflow.current_level ?? 0,
        approver_id: userId,
        is_active: true,
      },
    });
    if (!approval) {
      throw new ForbiddenException('No tienes asignada esta aprobación');
    }

    const businessDays = await this.businessDays.calculate(
      approval.created_at ?? new Date(),
      new Date(),
    );

    await this.prisma.approvals.update({
      where: { id: approval.id },
      data: {
        status: 'aprobada',
        approved_at: new Date(),
        time_to_approve: businessDays,
      },
    });

    const nextLevel = (workflow.current_level ?? 0) + 1;

    if (nextLevel > 4) {
      // Workflow completado
      await this.prisma.approval_workflows.update({
        where: { id: workflow.id },
        data: { status: 'aprobada', completed_at: new Date() },
      });
      await this.prisma.requisitions.update({
        where: { id: requisitionId },
        data: { status: 'aprobada' },
      });

      if (workflow.requisitions?.buyer_id) {
        this.socketService.emitToUser(
          workflow.requisitions.buyer_id,
          'notification',
          {
            type: 'requisition',
            action: 'approve',
            message: `La requisición ${workflow.requisitions.rq_number} ha sido aprobada y está lista para generar PO`,
            entityId: requisitionId,
          },
        );
      }

      this.logger.log(
        `Requisición ${workflow.requisitions?.rq_number} aprobada completamente`,
      );
    } else {
      await this.prisma.approval_workflows.update({
        where: { id: workflow.id },
        data: { current_level: nextLevel },
      });

      await this.notifyApprover(workflow.id, nextLevel, workflow.requisitions);

      this.logger.log(
        `Requisición ${workflow.requisitions?.rq_number} aprobada en nivel ${workflow.current_level}, avanzando a nivel ${nextLevel}`,
      );
    }

    return { success: true, message: 'Requisición aprobada' };
  }

  async reject(
    requisitionId: string,
    userId: string,
    userRole: string,
    rejectionReason: string,
  ) {
    const userLevel = Object.entries(APPROVAL_LEVELS).find(
      ([, role]) => role === userRole,
    )?.[0];
    if (!userLevel) {
      throw new ForbiddenException(
        'No tienes permisos para rechazar requisiciones',
      );
    }

    const workflow = await this.prisma.approval_workflows.findFirst({
      where: { requisition_id: requisitionId, is_active: true },
      include: { requisitions: true },
    });
    if (!workflow) {
      throw new NotFoundException(
        'No existe workflow de aprobación para esta requisición',
      );
    }
    if (workflow.status !== 'pendiente') {
      throw new BadRequestException(`El workflow ya está ${workflow.status}`);
    }

    const approval = await this.prisma.approvals.findFirst({
      where: {
        workflow_id: workflow.id,
        level: workflow.current_level ?? 0,
        approver_id: userId,
        is_active: true,
      },
    });
    if (!approval) {
      throw new ForbiddenException('No tienes asignada esta aprobación');
    }

    await this.prisma.approvals.update({
      where: { id: approval.id },
      data: {
        status: 'rechazada',
        rejected_at: new Date(),
        rejection_reason: rejectionReason,
      },
    });

    await this.prisma.approval_workflows.update({
      where: { id: workflow.id },
      data: { status: 'rechazada', completed_at: new Date() },
    });

    await this.prisma.requisitions.update({
      where: { id: requisitionId },
      data: { status: 'cancelada' }, // En el enum real no existe 'rechazada' para requisitions
    });

    if (workflow.requisitions?.requester_id) {
      this.socketService.emitToUser(
        workflow.requisitions.requester_id,
        'notification',
        {
          type: 'requisition',
          action: 'reject',
          message: `Tu requisición ${workflow.requisitions.rq_number} ha sido rechazada. Motivo: ${rejectionReason}`,
          entityId: requisitionId,
        },
      );
    }

    this.logger.log(
      `Requisición ${workflow.requisitions?.rq_number} rechazada en nivel ${workflow.current_level}`,
    );

    return { success: true, message: 'Requisición rechazada' };
  }

  async getStats() {
    const approvals = await this.prisma.approvals.findMany({
      where: { is_active: true },
      include: {
        profiles: { select: { id: true, full_name: true, role: true } },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statsByLevel: Record<number, any> = {};

    for (let level = 1; level <= 4; level++) {
      const levelApprovals = approvals.filter((a) => a.level === level);
      const approved = levelApprovals.filter((a) => a.status === 'aprobada');
      const rejected = levelApprovals.filter((a) => a.status === 'rechazada');
      const pending = levelApprovals.filter((a) => a.status === 'pendiente');

      const totalTime = approved.reduce(
        (sum, a) => sum + (a.time_to_approve || 0),
        0,
      );
      const avgTime =
        approved.length > 0 ? Math.round(totalTime / approved.length) : 0;

      statsByLevel[level] = {
        level,
        level_name: LEVEL_NAMES[level],
        total: levelApprovals.length,
        approved: approved.length,
        rejected: rejected.length,
        pending: pending.length,
        approval_rate:
          levelApprovals.length > 0
            ? Math.round(
                (approved.length / (approved.length + rejected.length || 1)) *
                  100,
              )
            : 0,
        average_time_days: avgTime,
        approver: levelApprovals[0]?.profiles ?? null,
      };
    }

    return statsByLevel;
  }

  private async notifyApprover(
    workflowId: string,
    level: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requisition: any,
  ) {
    const approval = await this.prisma.approvals.findFirst({
      where: { workflow_id: workflowId, level },
      select: { approver_id: true },
    });

    if (approval?.approver_id && requisition) {
      this.socketService.emitToUser(approval.approver_id, 'notification', {
        type: 'requisition',
        action: 'pending_approval',
        message: `Tienes una requisición pendiente de aprobación: ${requisition.rq_number}`,
        entityId: requisition.id,
      });
    }
  }
}
