import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { BaseCrudService } from '../../common/services/base-crud.service';
import { CreateOkrDto, OkrType } from './dto/create-okr.dto';
import { UpdateOkrDto, OkrStatus } from './dto/update-okr.dto';

export interface OkrRow {
  id: string;
  titulo: string;
  descripcion: string | null;
  periodo: string;
  tipo: string;
  parent_okr_id: string | null;
  target_value: number | null;
  current_value: number | null;
  unit: string | null;
  status: string;
  due_date: string | null;
  created_by: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  profiles?: { id: string; full_name: string } | null;
  children?: OkrRow[];
}

export interface OkrStats {
  total_objectives: number;
  total_key_results: number;
  completed: number;
  at_risk: number;
  avg_progress: number;
  by_status: { [key: string]: number };
}

@Injectable()
export class OkrsService extends BaseCrudService<CreateOkrDto, UpdateOkrDto> {
  protected readonly tableName = 'accounting_okrs';
  protected readonly selectFields = '*, profiles:created_by(id, full_name)';
  protected readonly orderField = 'created_at';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  /**
   * Obtiene todos los OKRs de un período con estructura jerárquica
   */
  async findByPeriodo(periodo: string): Promise<OkrRow[]> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('periodo', periodo)
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Estructurar jerárquicamente
    return this.buildHierarchy(data as OkrRow[]);
  }

  /**
   * Obtiene todos los OKRs activos (flat)
   */
  async findAll(): Promise<OkrRow[]> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('is_active', true)
      .order('periodo', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data as OkrRow[];
  }

  /**
   * Obtiene un OKR por ID
   */
  async findOne(id: string): Promise<OkrRow> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('id', id)
      .eq('is_active', true)
      .single();

    if (error || !data) throw new NotFoundException('OKR no encontrado');
    return data as OkrRow;
  }

  /**
   * Crea un nuevo OKR
   */
  async create(dto: CreateOkrDto, userId?: string): Promise<OkrRow> {
    // Validar que si es key_result debe tener parent_okr_id
    if (dto.tipo === OkrType.KEY_RESULT && !dto.parent_okr_id) {
      throw new BadRequestException('Los Key Results deben tener un objetivo padre (parent_okr_id)');
    }

    // Validar que el padre existe y es un objetivo
    if (dto.parent_okr_id) {
      const parent = await this.findOne(dto.parent_okr_id);
      if (parent.tipo !== 'objective') {
        throw new BadRequestException('El padre debe ser un objetivo, no un key result');
      }
    }

    const insertData = {
      titulo: dto.titulo,
      descripcion: dto.descripcion || null,
      periodo: dto.periodo,
      tipo: dto.tipo,
      parent_okr_id: dto.parent_okr_id || null,
      target_value: dto.target_value || null,
      current_value: dto.current_value || 0,
      unit: dto.unit || null,
      status: 'on_track',
      due_date: dto.due_date || null,
      created_by: userId || null,
    };

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .insert(insertData as any)
      .select(this.selectFields)
      .single();

    if (error) throw error;
    return data as OkrRow;
  }

  /**
   * Actualiza un OKR
   */
  async update(id: string, dto: UpdateOkrDto): Promise<OkrRow> {
    const updateData: any = {};

    // Solo incluir campos que vienen en el DTO
    if (dto.titulo !== undefined) updateData.titulo = dto.titulo;
    if (dto.descripcion !== undefined) updateData.descripcion = dto.descripcion;
    if (dto.periodo !== undefined) updateData.periodo = dto.periodo;
    if (dto.target_value !== undefined) updateData.target_value = dto.target_value;
    if (dto.current_value !== undefined) updateData.current_value = dto.current_value;
    if (dto.unit !== undefined) updateData.unit = dto.unit;
    if (dto.due_date !== undefined) updateData.due_date = dto.due_date;
    if (dto.status !== undefined) updateData.status = dto.status;

    // Auto-actualizar status basado en current_value vs target_value
    if (dto.current_value !== undefined && !dto.status) {
      const existing = await this.findOne(id);
      const targetValue = dto.target_value ?? existing.target_value ?? 0;
      const currentValue = dto.current_value;

      if (targetValue > 0) {
        const percentage = (currentValue / targetValue) * 100;
        if (percentage >= 100) {
          updateData.status = OkrStatus.COMPLETED;
        } else if (percentage >= 70) {
          updateData.status = OkrStatus.ON_TRACK;
        } else if (percentage >= 40) {
          updateData.status = OkrStatus.AT_RISK;
        } else {
          updateData.status = OkrStatus.BEHIND;
        }
      }
    }

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update(updateData)
      .eq('id', id)
      .select(this.selectFields)
      .single();

    if (error || !data) throw new NotFoundException('OKR no encontrado');

    // Actualizar status del objetivo padre si es key_result
    const okr = data as OkrRow;
    if (okr.parent_okr_id) {
      await this.updateParentStatus(okr.parent_okr_id);
    }

    return okr;
  }

  /**
   * Actualiza el status de un objetivo basado en sus key results
   */
  private async updateParentStatus(parentId: string): Promise<void> {
    const { data: keyResults } = await this.supabase.db
      .from(this.tableName)
      .select('current_value, target_value, status')
      .eq('parent_okr_id', parentId)
      .eq('is_active', true)
      .eq('tipo', 'key_result');

    if (!keyResults || keyResults.length === 0) return;

    // Calcular progreso promedio
    let totalProgress = 0;
    let countWithProgress = 0;

    keyResults.forEach((kr) => {
      if (kr.target_value && kr.target_value > 0) {
        totalProgress += ((kr.current_value || 0) / kr.target_value) * 100;
        countWithProgress++;
      }
    });

    const avgProgress = countWithProgress > 0 ? totalProgress / countWithProgress : 0;

    let status = 'on_track';
    if (avgProgress >= 100) {
      status = 'completed';
    } else if (avgProgress >= 70) {
      status = 'on_track';
    } else if (avgProgress >= 40) {
      status = 'at_risk';
    } else {
      status = 'behind';
    }

    await this.supabase.db
      .from(this.tableName)
      .update({ status } as any)
      .eq('id', parentId);
  }

  /**
   * Obtiene estadísticas de OKRs
   */
  async getStats(periodo?: string): Promise<OkrStats> {
    let query = this.supabase.db
      .from(this.tableName)
      .select('tipo, status, current_value, target_value')
      .eq('is_active', true);

    if (periodo) {
      query = query.eq('periodo', periodo);
    }

    const { data, error } = await query;
    if (error) throw error;

    const okrs = data as { tipo: string; status: string; current_value: number | null; target_value: number | null }[];

    const objectives = okrs.filter((o) => o.tipo === 'objective');
    const keyResults = okrs.filter((o) => o.tipo === 'key_result');

    const byStatus: { [key: string]: number } = {};
    okrs.forEach((o) => {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    });

    // Calcular progreso promedio
    let totalProgress = 0;
    let countWithProgress = 0;
    okrs.forEach((o) => {
      if (o.target_value && o.target_value > 0) {
        totalProgress += ((o.current_value || 0) / o.target_value) * 100;
        countWithProgress++;
      }
    });

    return {
      total_objectives: objectives.length,
      total_key_results: keyResults.length,
      completed: okrs.filter((o) => o.status === 'completed').length,
      at_risk: okrs.filter((o) => o.status === 'at_risk').length,
      avg_progress: countWithProgress > 0 ? Math.round(totalProgress / countWithProgress) : 0,
      by_status: byStatus,
    };
  }

  /**
   * Construye estructura jerárquica de OKRs
   */
  private buildHierarchy(okrs: OkrRow[]): OkrRow[] {
    const objectives = okrs.filter((o) => o.tipo === 'objective');
    const keyResults = okrs.filter((o) => o.tipo === 'key_result');

    return objectives.map((objective) => ({
      ...objective,
      children: keyResults.filter((kr) => kr.parent_okr_id === objective.id),
    }));
  }

  /**
   * Obtiene períodos disponibles
   */
  async getPeriodos(): Promise<string[]> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select('periodo')
      .eq('is_active', true);

    if (error) throw error;

    const uniquePeriodos = [...new Set((data as { periodo: string }[]).map((d) => d.periodo))];
    return uniquePeriodos.sort().reverse();
  }
}
