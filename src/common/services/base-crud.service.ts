import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { PaginationDto } from '../dto/pagination.dto';
import { PaginatedResponse } from '../interfaces/paginated-response.interface';

export abstract class BaseCrudService<CreateDto, UpdateDto> {
  protected abstract readonly tableName: string;
  protected abstract readonly selectFields: string;
  protected abstract readonly orderField: string;
  protected readonly searchFields: string[] = [];

  constructor(protected readonly supabase: SupabaseService) {}

  async findAll(): Promise<any[]> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .order(this.orderField);

    if (error) throw error;
    return data;
  }

  async findAllPaginated(
    pagination: PaginationDto,
  ): Promise<PaginatedResponse<any>> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const offset = (page - 1) * limit;

    let query = this.supabase.db
      .from(this.tableName)
      .select(this.selectFields, { count: 'exact' });

    if (pagination.search && this.searchFields.length > 0) {
      const filter = this.searchFields
        .map((f) => `${f}.ilike.%${pagination.search}%`)
        .join(',');
      query = query.or(filter);
    }

    query = query
      .order(this.orderField)
      .range(offset, offset + limit - 1);

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

  async findOne(id: string): Promise<any> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Registro no encontrado');
    return data;
  }

  async create(dto: CreateDto): Promise<any> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .insert(dto as any)
      .select(this.selectFields)
      .single();

    if (error) throw error;
    return data;
  }

  async update(id: string, dto: UpdateDto): Promise<any> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update(dto as any)
      .eq('id', id)
      .select(this.selectFields)
      .single();

    if (error || !data) throw new NotFoundException('Registro no encontrado');
    return data;
  }

  protected async validateFK(
    table: string,
    id: string,
    fieldName: string,
  ): Promise<void> {
    const { data, error } = await this.supabase.db
      .from(table)
      .select('id, is_active')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new BadRequestException(`${fieldName}: registro no encontrado`);
    }
    if (!(data as any).is_active) {
      throw new BadRequestException(
        `${fieldName}: el registro está desactivado`,
      );
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    const { error } = await this.supabase.db
      .from(this.tableName)
      .update({ is_active: false } as any)
      .eq('id', id);

    if (error) throw error;
    return { message: 'Registro desactivado correctamente' };
  }
}
