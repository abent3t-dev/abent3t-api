import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateRequisitionDto } from './dto/create-requisition.dto';
import { UpdateRequisitionDto } from './dto/update-requisition.dto';
import { FilterRequisitionDto } from './dto/filter-requisition.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

// Estados validos de requisicion (segun DB enum)
export type RequisitionStatus =
  | 'en_revision'
  | 'en_aprobacion'
  | 'aprobada'
  | 'en_progreso'
  | 'cerrada'
  | 'cancelada';

// Transiciones validas de estado
const VALID_TRANSITIONS: Record<RequisitionStatus, RequisitionStatus[]> = {
  en_revision: ['en_aprobacion', 'cancelada'],
  en_aprobacion: ['aprobada', 'cancelada'], // Requiere workflow de aprobacion
  aprobada: ['en_progreso', 'cancelada'],
  en_progreso: ['cerrada', 'cancelada'],
  cerrada: [], // Estado final
  cancelada: [], // Estado final
};

@Injectable()
export class RequisitionsService {
  private readonly logger = new Logger(RequisitionsService.name);
  private readonly tableName = 'requisitions';
  private readonly selectFields = `
    *,
    requester:profiles!requester_id(id, full_name, email),
    buyer:profiles!buyer_id(id, full_name, email),
    department:departments(id, name)
  `;

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Obtiene todas las requisiciones con filtros y paginacion
   */
  async findAll(pagination: PaginationDto, filters?: FilterRequisitionDto) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const offset = (page - 1) * limit;

    let query = this.supabase.db
      .from(this.tableName)
      .select(this.selectFields, { count: 'exact' })
      .eq('is_active', true);

    // Aplicar filtros
    if (filters?.status) {
      query = query.eq('status', filters.status);
    }
    if (filters?.expense_type) {
      query = query.eq('expense_type', filters.expense_type);
    }
    if (filters?.buyer_id) {
      query = query.eq('buyer_id', filters.buyer_id);
    }
    if (filters?.requester_id) {
      query = query.eq('requester_id', filters.requester_id);
    }
    if (filters?.department_id) {
      query = query.eq('department_id', filters.department_id);
    }
    if (filters?.source) {
      query = query.eq('source', filters.source);
    }
    if (filters?.date_from) {
      query = query.gte('created_date', filters.date_from);
    }
    if (filters?.date_to) {
      query = query.lte('created_date', filters.date_to);
    }

    // Busqueda por texto
    if (pagination.search) {
      query = query.or(
        `rq_number.ilike.%${pagination.search}%,description.ilike.%${pagination.search}%`,
      );
    }

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    const total = count ?? 0;
    return {
      data: data ?? [],
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

  /**
   * Obtiene estadisticas generales de requisiciones
   */
  async getStats(filters?: { date_from?: string; date_to?: string }) {
    let query = this.supabase.db
      .from(this.tableName)
      .select('status, expense_type, business_days_elapsed, estimated_amount')
      .eq('is_active', true);

    if (filters?.date_from) {
      query = query.gte('created_date', filters.date_from);
    }
    if (filters?.date_to) {
      query = query.lte('created_date', filters.date_to);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Contar por estado
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let totalDays = 0;
    let closedCount = 0;
    let totalAmount = 0;

    for (const rq of data || []) {
      byStatus[rq.status] = (byStatus[rq.status] || 0) + 1;
      byType[rq.expense_type] = (byType[rq.expense_type] || 0) + 1;
      totalAmount += rq.estimated_amount || 0;

      if (rq.status === 'cerrada' && rq.business_days_elapsed) {
        totalDays += rq.business_days_elapsed;
        closedCount++;
      }
    }

    return {
      total: data?.length || 0,
      by_status: byStatus,
      by_type: byType,
      total_estimated_amount: totalAmount,
      average_business_days: closedCount > 0 ? Math.round(totalDays / closedCount) : 0,
    };
  }

  /**
   * Obtiene una requisicion por ID
   */
  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Requisicion no encontrada');
    return data;
  }

  /**
   * Obtiene el historial de cambios de una requisicion
   */
  async getHistory(requisitionId: string) {
    const { data, error } = await this.supabase.db
      .from('requisition_history')
      .select(
        `
        *,
        changed_by_user:profiles!changed_by(id, full_name)
      `,
      )
      .eq('requisition_id', requisitionId)
      .order('changed_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Crea una nueva requisicion
   */
  async create(dto: CreateRequisitionDto, userId: string) {
    // Validar requester_id existe
    await this.validateFK('profiles', dto.requester_id, 'requester_id');

    // Validar buyer_id si se proporciona
    if (dto.buyer_id) {
      await this.validateFK('profiles', dto.buyer_id, 'buyer_id');
    }

    // Validar department_id si se proporciona
    if (dto.department_id) {
      await this.validateFK('departments', dto.department_id, 'department_id');
    }

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .insert({
        ...dto,
        status: 'en_revision',
      })
      .select(this.selectFields)
      .single();

    if (error) throw error;

    this.logger.log(`Requisicion ${data.rq_number} creada por usuario ${userId}`);

    return data;
  }

  /**
   * Actualiza una requisicion
   */
  async update(id: string, dto: UpdateRequisitionDto, userId: string) {
    const existing = await this.findOne(id);

    // No permitir actualizar si esta cerrada o cancelada
    if (['cerrada', 'cancelada'].includes(existing.status)) {
      throw new BadRequestException(
        `No se puede actualizar una requisicion con estado ${existing.status}`,
      );
    }

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update({
        ...dto,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select(this.selectFields)
      .single();

    if (error) throw error;

    // Registrar en historial
    await this.logHistory(id, 'general_update', JSON.stringify(existing), JSON.stringify(dto), userId);

    return data;
  }

  /**
   * Cambia el estado de una requisicion
   */
  async changeStatus(id: string, newStatus: RequisitionStatus, userId: string) {
    const existing = await this.findOne(id);
    const currentStatus = existing.status as RequisitionStatus;

    // Validar transicion de estado
    if (!VALID_TRANSITIONS[currentStatus]?.includes(newStatus)) {
      throw new BadRequestException(
        `Transicion de estado no permitida: ${currentStatus} -> ${newStatus}`,
      );
    }

    const updateData: any = {
      status: newStatus,
      updated_at: new Date().toISOString(),
    };

    // Si se cierra, calcular dias habiles y registrar fecha de cierre
    if (newStatus === 'cerrada') {
      updateData.closed_date = new Date().toISOString().split('T')[0];
      updateData.business_days_elapsed = await this.calculateBusinessDays(
        existing.created_date,
        updateData.closed_date,
      );
    }

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update(updateData)
      .eq('id', id)
      .select(this.selectFields)
      .single();

    if (error) throw error;

    // Registrar en historial
    await this.logHistory(id, 'status', currentStatus, newStatus, userId);

    this.logger.log(`Requisicion ${existing.rq_number} cambio de ${currentStatus} a ${newStatus}`);

    return data;
  }

  /**
   * Asigna un comprador a una requisicion
   */
  async assignBuyer(id: string, buyerId: string, userId: string) {
    const existing = await this.findOne(id);

    // Validar que el comprador existe
    await this.validateFK('profiles', buyerId, 'buyer_id');

    const oldBuyerId = existing.buyer_id;

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update({
        buyer_id: buyerId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select(this.selectFields)
      .single();

    if (error) throw error;

    // Registrar en historial
    await this.logHistory(id, 'buyer_id', oldBuyerId, buyerId, userId);

    this.logger.log(`Requisicion ${existing.rq_number} asignada a comprador ${buyerId}`);

    return data;
  }

  /**
   * Cancela una requisicion (soft-delete con cambio de estado)
   */
  async cancel(id: string, userId: string) {
    return this.changeStatus(id, 'cancelada', userId);
  }

  /**
   * Calcula dias habiles entre dos fechas
   * Usa la funcion de Supabase calculate_business_days()
   */
  async calculateBusinessDays(startDate: string, endDate: string): Promise<number> {
    const { data, error } = await this.supabase.db.rpc('calculate_business_days', {
      start_date: startDate,
      end_date: endDate,
    });

    if (error) {
      this.logger.error('Error calculando dias habiles:', error);
      return 0;
    }

    return data || 0;
  }

  /**
   * Registra un cambio en el historial
   */
  private async logHistory(
    requisitionId: string,
    fieldChanged: string,
    oldValue: string | null,
    newValue: string,
    changedBy: string,
  ) {
    const { error } = await this.supabase.db.from('requisition_history').insert({
      requisition_id: requisitionId,
      field_changed: fieldChanged,
      old_value: oldValue,
      new_value: newValue,
      changed_by: changedBy,
    });

    if (error) {
      this.logger.error('Error registrando historial:', error);
    }
  }

  /**
   * Valida que existe un registro en una tabla (FK)
   */
  private async validateFK(table: string, id: string, fieldName: string): Promise<void> {
    const { data, error } = await this.supabase.db
      .from(table)
      .select('id, is_active')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new BadRequestException(`${fieldName}: registro no encontrado`);
    }
    if (!(data as any).is_active) {
      throw new BadRequestException(`${fieldName}: el registro esta desactivado`);
    }
  }

  /**
   * Importa requisiciones desde un sistema externo (Maximo/SAP)
   */
  async importFromExternal(requisitions: CreateRequisitionDto[], source: 'maximo' | 'sap', userId: string) {
    const results = {
      imported: 0,
      failed: 0,
      errors: [] as string[],
    };

    for (const rq of requisitions) {
      try {
        // Verificar si ya existe por external_id
        if (rq.external_id) {
          const { data: existing } = await this.supabase.db
            .from(this.tableName)
            .select('id')
            .eq('external_id', rq.external_id)
            .eq('source', source)
            .single();

          if (existing) {
            results.errors.push(`RQ ${rq.external_id} ya existe en el sistema`);
            results.failed++;
            continue;
          }
        }

        await this.create({ ...rq, source }, userId);
        results.imported++;
      } catch (error: any) {
        results.failed++;
        results.errors.push(`Error importando RQ: ${error.message}`);
      }
    }

    this.logger.log(
      `Importacion desde ${source}: ${results.imported} exitosas, ${results.failed} fallidas`,
    );

    return results;
  }
}
