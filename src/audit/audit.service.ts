import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export type AuditAction = 'create' | 'update' | 'delete' | 'approve' | 'reject' | 'upload' | 'verify';
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
  | 'okr';

export interface AuditLogEntry {
  action: AuditAction;
  entity_type: AuditEntity;
  entity_id: string; // UUID especial '00000000-0000-0000-0000-000000000000' para operaciones masivas
  entity_name?: string;
  user_id: string;
  user_name?: string;
  user_role?: string;
  old_values?: Record<string, any>;
  new_values?: Record<string, any>;
  description?: string;
  ip_address?: string;
  user_agent?: string;
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

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Registra una acción en la bitácora de auditoría
   */
  async log(entry: AuditLogEntry): Promise<void> {
    try {
      const { error } = await this.supabase.db
        .from('audit_logs')
        .insert({
          action: entry.action,
          entity_type: entry.entity_type,
          entity_id: entry.entity_id,
          entity_name: entry.entity_name,
          user_id: entry.user_id,
          user_name: entry.user_name,
          user_role: entry.user_role,
          old_values: entry.old_values,
          new_values: entry.new_values,
          description: entry.description || this.generateDescription(entry),
          ip_address: entry.ip_address,
          user_agent: entry.user_agent,
        });

      if (error) {
        this.logger.error('Error registrando auditoría:', error);
      } else {
        this.logger.debug(`Audit: ${entry.action} ${entry.entity_type} ${entry.entity_id}`);
      }
    } catch (err) {
      // No bloquear la operación principal si falla el log
      this.logger.error('Error en auditoría:', err);
    }
  }

  /**
   * Genera descripción legible de la acción
   */
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
      // Contabilidad entities
      fiscal_loss: 'pérdida fiscal',
      non_deductible: 'gasto no deducible',
      shareholding: 'tenencia accionaria',
      okr: 'OKR',
    };

    const action = actionLabels[entry.action] || entry.action;
    const entity = entityLabels[entry.entity_type] || entry.entity_type;
    const name = entry.entity_name ? `: ${entry.entity_name}` : '';

    return `${entry.user_name || 'Usuario'} ${action} ${entity}${name}`;
  }

  /**
   * Obtiene logs de auditoría con filtros
   */
  async findAll(filters: AuditFilters, page = 1, limit = 15) {
    const offset = (page - 1) * limit;

    let query = this.supabase.db
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters.action) {
      query = query.eq('action', filters.action);
    }
    if (filters.entity_type) {
      query = query.eq('entity_type', filters.entity_type);
    }
    if (filters.entity_id) {
      query = query.eq('entity_id', filters.entity_id);
    }
    if (filters.user_id) {
      query = query.eq('user_id', filters.user_id);
    }
    if (filters.start_date) {
      query = query.gte('created_at', filters.start_date);
    }
    if (filters.end_date) {
      query = query.lte('created_at', filters.end_date);
    }

    const { data, error, count } = await query;

    if (error) throw error;

    const total = count || 0;
    const totalPages = Math.ceil(total / limit);

    return {
      data,
      total,
      page,
      limit,
      totalPages,
    };
  }

  /**
   * Obtiene logs de una entidad específica
   */
  async findByEntity(entityType: AuditEntity, entityId: string) {
    const { data, error } = await this.supabase.db
      .from('audit_logs')
      .select('*')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  /**
   * Obtiene logs de un usuario específico
   */
  async findByUser(userId: string, limit = 50) {
    const { data, error } = await this.supabase.db
      .from('audit_logs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  }

  /**
   * Obtiene estadísticas de auditoría
   */
  async getStats(startDate?: string, endDate?: string) {
    let query = this.supabase.db
      .from('audit_logs')
      .select('action, entity_type');

    if (startDate) {
      query = query.gte('created_at', startDate);
    }
    if (endDate) {
      query = query.lte('created_at', endDate);
    }

    const { data, error } = await query;

    if (error) throw error;

    // Contar por acción
    const byAction: Record<string, number> = {};
    const byEntity: Record<string, number> = {};

    for (const log of data || []) {
      byAction[log.action] = (byAction[log.action] || 0) + 1;
      byEntity[log.entity_type] = (byEntity[log.entity_type] || 0) + 1;
    }

    return {
      total: data?.length || 0,
      by_action: byAction,
      by_entity: byEntity,
    };
  }
}
