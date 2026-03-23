import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
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
export class BudgetsService {
  constructor(private readonly supabase: SupabaseService) {}

  private calculateAvailable(budget: BudgetRow) {
    return {
      ...budget,
      available_amount: budget.assigned_amount - budget.consumed_amount,
    };
  }

  async findAll() {
    const { data, error } = await this.supabase.db
      .from('budgets')
      .select(
        '*, departments(id, name), periods(id, label, year, semester)',
      )
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as BudgetRow[]).map(this.calculateAvailable);
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('budgets')
      .select(
        '*, departments(id, name), periods(id, label, year, semester)',
      )
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException('Presupuesto no encontrado');
    }
    return this.calculateAvailable(data as BudgetRow);
  }

  async findByDepartment(departmentId: string) {
    const { data, error } = await this.supabase.db
      .from('budgets')
      .select(
        '*, departments(id, name), periods(id, label, year, semester)',
      )
      .eq('department_id', departmentId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as BudgetRow[]).map(this.calculateAvailable);
  }

  async findByPeriod(periodId: string) {
    const { data, error } = await this.supabase.db
      .from('budgets')
      .select(
        '*, departments(id, name), periods(id, label, year, semester)',
      )
      .eq('period_id', periodId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as BudgetRow[]).map(this.calculateAvailable);
  }

  async create(dto: CreateBudgetDto) {
    const { data, error } = await this.supabase.db
      .from('budgets')
      .insert({
        ...dto,
        consumed_amount: 0,
      })
      .select(
        '*, departments(id, name), periods(id, label, year, semester)',
      )
      .single();

    if (error) throw error;
    return this.calculateAvailable(data as BudgetRow);
  }

  async update(id: string, dto: UpdateBudgetDto) {
    const { data, error } = await this.supabase.db
      .from('budgets')
      .update(dto)
      .eq('id', id)
      .select(
        '*, departments(id, name), periods(id, label, year, semester)',
      )
      .single();

    if (error || !data) {
      throw new NotFoundException('Presupuesto no encontrado');
    }
    return this.calculateAvailable(data as BudgetRow);
  }

  async remove(id: string) {
    const { error } = await this.supabase.db
      .from('budgets')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;
    return { message: 'Presupuesto desactivado' };
  }
}
