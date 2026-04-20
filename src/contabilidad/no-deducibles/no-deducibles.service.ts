import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { BaseCrudService } from '../../common/services/base-crud.service';
import { CreateNoDeducibleDto } from './dto/create-no-deducible.dto';
import { UpdateNoDeducibleDto } from './dto/update-no-deducible.dto';

export interface NoDeducibleRow {
  id: string;
  department_id: string;
  periodo: string;
  concepto: string;
  monto: number;
  cfdi_uuid: string | null;
  notes: string | null;
  created_by: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  departments?: { id: string; name: string } | null;
}

export interface DepartmentStats {
  department_id: string;
  department_name: string;
  total_monto: number;
  count: number;
}

export interface PeriodTrend {
  periodo: string;
  total: number;
  count: number;
}

@Injectable()
export class NoDeduciblesService extends BaseCrudService<CreateNoDeducibleDto, UpdateNoDeducibleDto> {
  protected readonly tableName = 'non_deductibles';
  protected readonly selectFields = '*, departments(id, name)';
  protected readonly orderField = 'created_at';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  /**
   * Obtiene todos los no deducibles activos
   */
  async findAll(): Promise<NoDeducibleRow[]> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data as NoDeducibleRow[];
  }

  /**
   * Obtiene no deducibles por departamento
   */
  async findByDepartment(departmentId: string): Promise<NoDeducibleRow[]> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('department_id', departmentId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data as NoDeducibleRow[];
  }

  /**
   * Obtiene no deducibles por período
   */
  async findByPeriodo(periodo: string): Promise<NoDeducibleRow[]> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('periodo', periodo)
      .eq('is_active', true)
      .order('department_id');

    if (error) throw error;
    return data as NoDeducibleRow[];
  }

  /**
   * Crea un nuevo no deducible
   */
  async create(dto: CreateNoDeducibleDto, userId?: string): Promise<NoDeducibleRow> {
    await this.validateFK('departments', dto.department_id, 'department_id');

    const insertData = {
      department_id: dto.department_id,
      periodo: dto.periodo,
      concepto: dto.concepto,
      monto: dto.monto,
      cfdi_uuid: dto.cfdi_uuid || null,
      notes: dto.notes || null,
      created_by: userId || null,
    };

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .insert(insertData as any)
      .select(this.selectFields)
      .single();

    if (error) throw error;
    return data as NoDeducibleRow;
  }

  /**
   * Obtiene estadísticas por departamento
   */
  async getStatsByDepartment(periodo?: string): Promise<DepartmentStats[]> {
    let query = this.supabase.db
      .from(this.tableName)
      .select('*, departments(id, name)')
      .eq('is_active', true);

    if (periodo) {
      query = query.eq('periodo', periodo);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Agrupar por departamento
    const stats: { [key: string]: DepartmentStats } = {};

    (data as NoDeducibleRow[]).forEach((item) => {
      const deptId = item.department_id;
      const deptName = item.departments?.name || 'Sin departamento';

      if (!stats[deptId]) {
        stats[deptId] = {
          department_id: deptId,
          department_name: deptName,
          total_monto: 0,
          count: 0,
        };
      }

      stats[deptId].total_monto += item.monto;
      stats[deptId].count += 1;
    });

    return Object.values(stats).sort((a, b) => b.total_monto - a.total_monto);
  }

  /**
   * Obtiene tendencia mensual
   */
  async getTrend(year?: number): Promise<PeriodTrend[]> {
    const targetYear = year || new Date().getFullYear();

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select('periodo, monto')
      .eq('is_active', true)
      .like('periodo', `${targetYear}%`);

    if (error) throw error;

    // Agrupar por período
    const trends: { [key: string]: PeriodTrend } = {};

    (data as { periodo: string; monto: number }[]).forEach((item) => {
      if (!trends[item.periodo]) {
        trends[item.periodo] = {
          periodo: item.periodo,
          total: 0,
          count: 0,
        };
      }
      trends[item.periodo].total += item.monto;
      trends[item.periodo].count += 1;
    });

    return Object.values(trends).sort((a, b) => a.periodo.localeCompare(b.periodo));
  }

  /**
   * Obtiene estadísticas generales
   */
  async getStats(periodo?: string): Promise<{
    total: number;
    count: number;
    by_department: DepartmentStats[];
    trend: PeriodTrend[];
    top_conceptos: { concepto: string; total: number }[];
  }> {
    const byDepartment = await this.getStatsByDepartment(periodo);
    const trend = await this.getTrend();

    // Obtener top conceptos
    let query = this.supabase.db
      .from(this.tableName)
      .select('concepto, monto')
      .eq('is_active', true);

    if (periodo) {
      query = query.eq('periodo', periodo);
    }

    const { data: conceptos, error } = await query;
    if (error) throw error;

    const conceptoMap: { [key: string]: number } = {};
    (conceptos as { concepto: string; monto: number }[]).forEach((item) => {
      conceptoMap[item.concepto] = (conceptoMap[item.concepto] || 0) + item.monto;
    });

    const topConceptos = Object.entries(conceptoMap)
      .map(([concepto, total]) => ({ concepto, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    const total = byDepartment.reduce((sum, d) => sum + d.total_monto, 0);
    const count = byDepartment.reduce((sum, d) => sum + d.count, 0);

    return {
      total,
      count,
      by_department: byDepartment,
      trend,
      top_conceptos: topConceptos,
    };
  }
}
