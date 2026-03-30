import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BaseCrudService } from '../common/services/base-crud.service';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';

interface BudgetRow {
  id: string;
  department_id: string;
  period_id: string;
  assigned_amount: number;
  consumed_amount: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  departments: { id: string; name: string } | null;
  periods: { id: string; label: string; year: number; semester: number } | null;
}

@Injectable()
export class BudgetsService extends BaseCrudService<CreateBudgetDto, UpdateBudgetDto> {
  protected readonly tableName = 'budgets';
  protected readonly selectFields = '*, departments(id, name), periods(id, label, year, semester)';
  protected readonly orderField = 'created_at';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  private calculateAvailable(budget: BudgetRow) {
    return {
      ...budget,
      available_amount: budget.assigned_amount - budget.consumed_amount,
    };
  }

  async findAll() {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as BudgetRow[]).map(this.calculateAvailable);
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('id', id)
      .eq('is_active', true)
      .single();

    if (error || !data) throw new NotFoundException('Presupuesto no encontrado');
    return this.calculateAvailable(data as BudgetRow);
  }

  async findByDepartment(departmentId: string) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('department_id', departmentId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as BudgetRow[]).map(this.calculateAvailable);
  }

  async findByPeriod(periodId: string) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('period_id', periodId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as BudgetRow[]).map(this.calculateAvailable);
  }

  async create(dto: CreateBudgetDto) {
    await Promise.all([
      this.validateFK('departments', dto.department_id, 'department_id'),
      this.validateFK('periods', dto.period_id, 'period_id'),
    ]);

    // Check uniqueness: one active budget per department+period
    const { data: existing } = await this.supabase.db
      .from('budgets')
      .select('id')
      .eq('department_id', dto.department_id)
      .eq('period_id', dto.period_id)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (existing) {
      throw new BadRequestException(
        'Ya existe un presupuesto activo para este departamento y periodo',
      );
    }

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .insert({ ...dto, consumed_amount: 0 } as any)
      .select(this.selectFields)
      .single();

    if (error) throw error;
    return this.calculateAvailable(data as BudgetRow);
  }

  async update(id: string, dto: UpdateBudgetDto) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update(dto as any)
      .eq('id', id)
      .select(this.selectFields)
      .single();

    if (error || !data) throw new NotFoundException('Presupuesto no encontrado');
    return this.calculateAvailable(data as BudgetRow);
  }
}
