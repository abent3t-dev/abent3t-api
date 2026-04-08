import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BaseCrudService } from '../common/services/base-crud.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Injectable()
export class SuppliersService extends BaseCrudService<CreateSupplierDto, UpdateSupplierDto> {
  protected readonly tableName = 'suppliers';
  protected readonly selectFields = '*';
  protected readonly orderField = 'legal_name';
  protected readonly searchFields = ['legal_name', 'commercial_name', 'tax_id', 'email'];
  private readonly logger = new Logger(SuppliersService.name);

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  /**
   * Busca proveedores con filtros adicionales
   */
  async findAllFiltered(
    pagination: PaginationDto,
    filters?: {
      is_blocked?: boolean;
      min_score?: number;
    },
  ) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const offset = (page - 1) * limit;

    let query = this.supabase.db
      .from(this.tableName)
      .select('*', { count: 'exact' })
      .eq('is_active', true);

    // Filtros
    if (filters?.is_blocked !== undefined) {
      query = query.eq('is_blocked', filters.is_blocked);
    }

    if (filters?.min_score !== undefined) {
      query = query.gte('performance_score', filters.min_score);
    }

    // Busqueda por texto
    if (pagination.search && this.searchFields.length > 0) {
      const filter = this.searchFields
        .map((f) => `${f}.ilike.%${pagination.search}%`)
        .join(',');
      query = query.or(filter);
    }

    query = query.order(this.orderField).range(offset, offset + limit - 1);

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
   * Obtiene el desempeno de un proveedor
   */
  async getPerformance(supplierId: string) {
    // Verificar que el proveedor existe
    const supplier = await this.findOne(supplierId);

    // Obtener POs del proveedor
    const { data: pos, error: posError } = await this.supabase.db
      .from('purchase_orders')
      .select('id, status, expected_delivery_date, actual_delivery_date, amount')
      .eq('supplier_id', supplierId)
      .eq('is_active', true);

    if (posError) throw posError;

    // Calcular metricas
    const totalOrders = pos?.length || 0;
    const deliveredOrders = pos?.filter((po) => po.status === 'entregada_completa') || [];
    const onTimeDeliveries = deliveredOrders.filter(
      (po) =>
        po.actual_delivery_date &&
        new Date(po.actual_delivery_date) <= new Date(po.expected_delivery_date),
    );

    const totalAmount = pos?.reduce((sum, po) => sum + (po.amount || 0), 0) || 0;

    return {
      supplier_id: supplierId,
      supplier_name: supplier.legal_name,
      performance_score: supplier.performance_score || 0,
      total_orders: totalOrders,
      delivered_orders: deliveredOrders.length,
      on_time_delivery_rate:
        deliveredOrders.length > 0
          ? Math.round((onTimeDeliveries.length / deliveredOrders.length) * 100)
          : 0,
      total_amount: totalAmount,
      is_blocked: supplier.is_blocked,
    };
  }

  /**
   * Obtiene las POs de un proveedor
   */
  async getPurchaseOrders(supplierId: string, pagination: PaginationDto) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase.db
      .from('purchase_orders')
      .select(
        `
        *,
        requisitions(rq_number, description)
      `,
        { count: 'exact' },
      )
      .eq('supplier_id', supplierId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

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
   * Evalua el desempeno de un proveedor
   */
  async evaluate(supplierId: string, score: number, userId: string) {
    if (score < 0 || score > 100) {
      throw new BadRequestException('El puntaje debe estar entre 0 y 100');
    }

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update({
        performance_score: score,
        updated_at: new Date().toISOString(),
      })
      .eq('id', supplierId)
      .select('*')
      .single();

    if (error) throw error;

    this.logger.log(`Proveedor ${supplierId} evaluado con puntaje ${score} por usuario ${userId}`);

    return data;
  }

  /**
   * Bloquea un proveedor
   */
  async block(supplierId: string, reason: string, userId: string) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update({
        is_blocked: true,
        blocked_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', supplierId)
      .select('*')
      .single();

    if (error) throw error;

    this.logger.warn(`Proveedor ${supplierId} bloqueado por usuario ${userId}. Razon: ${reason}`);

    return data;
  }

  /**
   * Desbloquea un proveedor
   */
  async unblock(supplierId: string, userId: string) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update({
        is_blocked: false,
        blocked_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', supplierId)
      .select('*')
      .single();

    if (error) throw error;

    this.logger.log(`Proveedor ${supplierId} desbloqueado por usuario ${userId}`);

    return data;
  }

  /**
   * Verifica unicidad del RFC antes de crear
   */
  async create(dto: CreateSupplierDto) {
    // Verificar que el RFC no exista
    const { data: existing } = await this.supabase.db
      .from(this.tableName)
      .select('id')
      .eq('tax_id', dto.tax_id)
      .single();

    if (existing) {
      throw new BadRequestException(`Ya existe un proveedor con el RFC ${dto.tax_id}`);
    }

    return super.create(dto);
  }
}
