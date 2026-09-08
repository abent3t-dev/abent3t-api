import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'approve'
  | 'reject'
  | 'upload'
  | 'verify';
export type AuditEntity =
  | 'course'
  | 'course_edition'
  | 'enrollment'
  | 'evidence'
  | 'budget'
  | 'request'
  | 'user'
  | 'proposal'
  // Contabilidad entities
  | 'fiscal_loss'
  | 'non_deductible'
  | 'shareholding'
  | 'okr'
  // Compras (§16): primera entidad de compras auditada
  | 'committee';

export interface AuditLogEntry {
  action: AuditAction;
  entity_type: AuditEntity;
  entity_id: string; // UUID especial '00000000-0000-0000-0000-000000000000' para operaciones masivas
  entity_name?: string | null;
  user_id: string;
  user_name?: string | null;
  user_role?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  old_values?: Record<string, any> | object;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new_values?: Record<string, any> | object;
  description?: string;
  ip_address?: string | null;
  user_agent?: string | null;
}

interface AuditFilters {
  action?: AuditAction;
  entity_type?: AuditEntity;
  entity_id?: string;
  user_id?: string;
  start_date?: string;
  end_date?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra una acción en la bitácora de auditoría. No bloquea la operación
   * principal si falla — solo loguea el error.
   */
  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        data: {
          action: entry.action,
          entity_type: entry.entity_type,
          entity_id: entry.entity_id,
          entity_name: entry.entity_name ?? null,
          user_id: entry.user_id,
          user_name: entry.user_name ?? null,
          user_role: entry.user_role ?? null,
          old_values: (entry.old_values ?? null) as Prisma.InputJsonValue,
          new_values: (entry.new_values ?? null) as Prisma.InputJsonValue,
          description: entry.description || this.generateDescription(entry),
          ip_address: entry.ip_address ?? null,
          user_agent: entry.user_agent ?? null,
        },
      });
      this.logger.debug(
        `Audit: ${entry.action} ${entry.entity_type} ${entry.entity_id}`,
      );
    } catch (err) {
      this.logger.error('Error en auditoría:', err);
    }
  }

  /** Genera descripción legible de la acción */
  private generateDescription(entry: AuditLogEntry): string {
    const actionLabels: Record<AuditAction, string> = {
      create: 'creó',
      update: 'actualizó',
      delete: 'eliminó',
      approve: 'aprobó',
      reject: 'rechazó',
      upload: 'subió',
      verify: 'verificó',
    };

    const entityLabels: Record<AuditEntity, string> = {
      course: 'curso',
      course_edition: 'edición de curso',
      enrollment: 'inscripción',
      evidence: 'evidencia',
      budget: 'presupuesto',
      request: 'solicitud',
      user: 'usuario',
      proposal: 'propuesta de curso',
      fiscal_loss: 'pérdida fiscal',
      non_deductible: 'gasto no deducible',
      shareholding: 'tenencia accionaria',
      okr: 'OKR',
      committee: 'comité de compras',
    };

    const action = actionLabels[entry.action] || entry.action;
    const entity = entityLabels[entry.entity_type] || entry.entity_type;
    const name = entry.entity_name ? `: ${entry.entity_name}` : '';

    return `${entry.user_name || 'Usuario'} ${action} ${entity}${name}`;
  }

  /** Obtiene logs de auditoría con filtros y paginación */
  async findAll(filters: AuditFilters, page = 1, limit = 15) {
    const skip = (page - 1) * limit;

    const where: Prisma.audit_logsWhereInput = {};
    if (filters.action) where.action = filters.action;
    if (filters.entity_type) where.entity_type = filters.entity_type;
    if (filters.entity_id) where.entity_id = filters.entity_id;
    if (filters.user_id) where.user_id = filters.user_id;
    if (filters.start_date || filters.end_date) {
      const range: Prisma.DateTimeNullableFilter = {};
      if (filters.start_date) range.gte = new Date(filters.start_date);
      if (filters.end_date) range.lte = new Date(filters.end_date);
      where.created_at = range;
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.audit_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.audit_logs.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;
    return { data, total, page, limit, totalPages };
  }

  async findByEntity(entityType: AuditEntity, entityId: string) {
    return this.prisma.audit_logs.findMany({
      where: { entity_type: entityType, entity_id: entityId },
      orderBy: { created_at: 'desc' },
    });
  }

  async findByUser(userId: string, limit = 50) {
    return this.prisma.audit_logs.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  async getStats(startDate?: string, endDate?: string) {
    const where: Prisma.audit_logsWhereInput = {};
    if (startDate || endDate) {
      const range: Prisma.DateTimeNullableFilter = {};
      if (startDate) range.gte = new Date(startDate);
      if (endDate) range.lte = new Date(endDate);
      where.created_at = range;
    }

    const data = await this.prisma.audit_logs.findMany({
      where,
      select: { action: true, entity_type: true },
    });

    const byAction: Record<string, number> = {};
    const byEntity: Record<string, number> = {};
    for (const log of data) {
      byAction[log.action] = (byAction[log.action] || 0) + 1;
      byEntity[log.entity_type] = (byEntity[log.entity_type] || 0) + 1;
    }

    return {
      total: data.length,
      by_action: byAction,
      by_entity: byEntity,
    };
  }
}
