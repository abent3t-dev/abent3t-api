import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

// Estados de PO
export type POStatus = 'emitida' | 'en_transito' | 'entregada_parcial' | 'entregada_completa' | 'cancelada';

// Transiciones validas
const VALID_TRANSITIONS: Record<POStatus, POStatus[]> = {
  emitida: ['en_transito', 'cancelada'],
  en_transito: ['entregada_parcial', 'entregada_completa', 'cancelada'],
  entregada_parcial: ['entregada_completa', 'cancelada'],
  entregada_completa: [], // Estado final
  cancelada: [], // Estado final
};

@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);
  private readonly tableName = 'purchase_orders';
  private readonly selectFields = `
    *,
    requisition:requisitions(id, rq_number, description, expense_type, requester_id),
    supplier:suppliers(id, legal_name, commercial_name, tax_id, email),
    buyer:profiles!buyer_id(id, full_name),
    purchase_type:purchase_types(id, name, key)
  `;

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Obtiene todas las POs con filtros y paginacion
   */
  async findAll(
    pagination: PaginationDto,
    filters?: {
      status?: POStatus;
      supplier_id?: string;
      purchase_type_id?: string;
      expense_type?: string; // CAPEX/OPEX
      date_from?: string;
      date_to?: string;
    },
  ) {
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
    if (filters?.supplier_id) {
      query = query.eq('supplier_id', filters.supplier_id);
    }
    if (filters?.purchase_type_id) {
      query = query.eq('purchase_type_id', filters.purchase_type_id);
    }
    if (filters?.date_from) {
      query = query.gte('created_at', filters.date_from);
    }
    if (filters?.date_to) {
      query = query.lte('created_at', filters.date_to);
    }

    // Busqueda por texto
    if (pagination.search) {
      query = query.or(`po_number.ilike.%${pagination.search}%`);
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
   * Obtiene una PO por ID
   */
  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Orden de compra no encontrada');
    return data;
  }

  /**
   * Obtiene las POs de una requisicion
   */
  async findByRequisition(requisitionId: string) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('requisition_id', requisitionId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Crea una nueva PO desde una requisicion aprobada
   */
  async create(dto: CreatePurchaseOrderDto, userId: string) {
    // Verificar que la requisicion existe y esta aprobada
    const { data: requisition, error: rqError } = await this.supabase.db
      .from('requisitions')
      .select('*')
      .eq('id', dto.requisition_id)
      .eq('is_active', true)
      .single();

    if (rqError || !requisition) {
      throw new NotFoundException('Requisicion no encontrada');
    }

    if (requisition.status !== 'aprobada') {
      throw new BadRequestException('Solo se pueden crear POs desde requisiciones aprobadas');
    }

    // Verificar que el proveedor existe y no esta bloqueado
    const { data: supplier, error: supplierError } = await this.supabase.db
      .from('suppliers')
      .select('*')
      .eq('id', dto.supplier_id)
      .eq('is_active', true)
      .single();

    if (supplierError || !supplier) {
      throw new NotFoundException('Proveedor no encontrado');
    }

    if (supplier.is_blocked) {
      throw new BadRequestException('El proveedor esta bloqueado y no puede recibir ordenes de compra');
    }

    // Verificar contrato si se proporciona
    if (dto.contract_id) {
      const { data: contract, error: contractError } = await this.supabase.db
        .from('contracts')
        .select('*')
        .eq('id', dto.contract_id)
        .eq('is_active', true)
        .single();

      if (contractError || !contract) {
        throw new NotFoundException('Contrato no encontrado');
      }

      // Verificar que el contrato no este vencido
      if (new Date(contract.end_date) < new Date()) {
        throw new BadRequestException('El contrato esta vencido');
      }
    }

    // Crear la PO
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .insert({
        ...dto,
        expense_type: requisition.expense_type, // Heredar CAPEX/OPEX de la RQ
        status: 'emitida',
        buyer_id: userId,
      })
      .select(this.selectFields)
      .single();

    if (error) throw error;

    // Actualizar la requisicion a "en_progreso" si estaba aprobada
    await this.supabase.db
      .from('requisitions')
      .update({ status: 'en_progreso', updated_at: new Date().toISOString() })
      .eq('id', dto.requisition_id);

    this.logger.log(`PO ${data.po_number} creada para requisicion ${requisition.rq_number}`);

    return data;
  }

  /**
   * Actualiza una PO
   */
  async update(id: string, dto: UpdatePurchaseOrderDto, userId: string) {
    const existing = await this.findOne(id);

    // No permitir actualizar si esta entregada o cancelada
    if (['entregada_completa', 'cancelada'].includes(existing.status)) {
      throw new BadRequestException(
        `No se puede actualizar una PO con estado ${existing.status}`,
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

    this.logger.log(`PO ${existing.po_number} actualizada por usuario ${userId}`);

    return data;
  }

  /**
   * Cambia el estado de una PO
   */
  async changeStatus(id: string, newStatus: POStatus, userId: string, actualDeliveryDate?: string) {
    const existing = await this.findOne(id);
    const currentStatus = existing.status as POStatus;

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

    // Si se entrega, registrar fecha de entrega
    if (['entregada_parcial', 'entregada_completa'].includes(newStatus)) {
      updateData.actual_delivery_date = actualDeliveryDate || new Date().toISOString().split('T')[0];
    }

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update(updateData)
      .eq('id', id)
      .select(this.selectFields)
      .single();

    if (error) throw error;

    // Si la PO se entrega completamente, cerrar la requisicion
    if (newStatus === 'entregada_completa') {
      // Verificar si todas las POs de la requisicion estan entregadas
      const { data: allPos } = await this.supabase.db
        .from(this.tableName)
        .select('status')
        .eq('requisition_id', existing.requisition_id)
        .eq('is_active', true);

      const allDelivered = allPos?.every((po) => po.status === 'entregada_completa');

      if (allDelivered) {
        await this.supabase.db
          .from('requisitions')
          .update({
            status: 'cerrada',
            closed_date: new Date().toISOString().split('T')[0],
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.requisition_id);

        // Calcular dias habiles
        const { data: rq } = await this.supabase.db
          .from('requisitions')
          .select('created_date')
          .eq('id', existing.requisition_id)
          .single();

        if (rq) {
          const { data: businessDays } = await this.supabase.db.rpc('calculate_business_days', {
            start_date: rq.created_date,
            end_date: new Date().toISOString().split('T')[0],
          });

          await this.supabase.db
            .from('requisitions')
            .update({ business_days_elapsed: businessDays || 0 })
            .eq('id', existing.requisition_id);
        }
      }
    }

    this.logger.log(`PO ${existing.po_number} cambio de ${currentStatus} a ${newStatus}`);

    return data;
  }

  /**
   * Cancela una PO
   */
  async cancel(id: string, userId: string) {
    return this.changeStatus(id, 'cancelada', userId);
  }

  /**
   * Obtiene estadisticas de POs
   */
  async getStats(filters?: { date_from?: string; date_to?: string; expense_type?: string }) {
    let query = this.supabase.db
      .from(this.tableName)
      .select('status, expense_type, purchase_type_id, amount, purchase_type:purchase_types(name)')
      .eq('is_active', true);

    if (filters?.date_from) {
      query = query.gte('created_at', filters.date_from);
    }
    if (filters?.date_to) {
      query = query.lte('created_at', filters.date_to);
    }
    if (filters?.expense_type) {
      query = query.eq('expense_type', filters.expense_type);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Calcular estadisticas
    const byStatus: Record<string, { count: number; amount: number }> = {};
    const byType: Record<string, { count: number; amount: number }> = {};
    const byPurchaseType: Record<string, { count: number; amount: number }> = {};
    let totalAmount = 0;

    for (const po of data || []) {
      // Por status
      if (!byStatus[po.status]) {
        byStatus[po.status] = { count: 0, amount: 0 };
      }
      byStatus[po.status].count++;
      byStatus[po.status].amount += po.amount || 0;

      // Por tipo de gasto (CAPEX/OPEX)
      if (po.expense_type) {
        if (!byType[po.expense_type]) {
          byType[po.expense_type] = { count: 0, amount: 0 };
        }
        byType[po.expense_type].count++;
        byType[po.expense_type].amount += po.amount || 0;
      }

      // Por tipo de compra
      const purchaseTypeName = (po.purchase_type as any)?.name;
      if (purchaseTypeName) {
        if (!byPurchaseType[purchaseTypeName]) {
          byPurchaseType[purchaseTypeName] = { count: 0, amount: 0 };
        }
        byPurchaseType[purchaseTypeName].count++;
        byPurchaseType[purchaseTypeName].amount += po.amount || 0;
      }

      totalAmount += po.amount || 0;
    }

    return {
      total: data?.length || 0,
      total_amount: totalAmount,
      by_status: byStatus,
      by_type: byType,
      by_purchase_type: byPurchaseType,
    };
  }
}
