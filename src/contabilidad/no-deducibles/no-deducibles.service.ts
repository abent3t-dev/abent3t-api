import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseCrudPrismaService } from '../../common/services/base-crud-prisma.service';
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
export class NoDeduciblesService extends BaseCrudPrismaService<
  CreateNoDeducibleDto,
  UpdateNoDeducibleDto
> {
  protected get model() {
    return this.prisma.non_deductibles;
  }
  protected readonly orderField = 'created_at';
  protected readonly include = {
    departments: { select: { id: true, name: true } },
  };

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Obtiene todos los no deducibles activos
   */
  async findAll(): Promise<NoDeducibleRow[]> {
    const data = await this.prisma.non_deductibles.findMany({
      where: { is_active: true },
      include: this.include,
      orderBy: { created_at: 'desc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data as any as NoDeducibleRow[];
  }

  /**
   * Obtiene no deducibles por departamento
   */
  async findByDepartment(departmentId: string): Promise<NoDeducibleRow[]> {
    const data = await this.prisma.non_deductibles.findMany({
      where: { department_id: departmentId, is_active: true },
      include: this.include,
      orderBy: { created_at: 'desc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data as any as NoDeducibleRow[];
  }

  /**
   * Obtiene no deducibles por período
   */
  async findByPeriodo(periodo: string): Promise<NoDeducibleRow[]> {
    const data = await this.prisma.non_deductibles.findMany({
      where: { periodo, is_active: true },
      include: this.include,
      orderBy: { department_id: 'asc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data as any as NoDeducibleRow[];
  }

  /**
   * Crea un nuevo no deducible
   */
  async create(dto: CreateNoDeducibleDto, userId?: string): Promise<NoDeducibleRow> {
    await this.validateFK(this.prisma.departments, dto.department_id, 'department_id');

    const insertData = {
      department_id: dto.department_id,
      periodo: dto.periodo,
      concepto: dto.concepto,
      monto: dto.monto,
      cfdi_uuid: dto.cfdi_uuid || null,
      notes: dto.notes || null,
      created_by: userId || null,
    };

    const data = await this.prisma.non_deductibles.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: insertData as any,
      include: this.include,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data as any as NoDeducibleRow;
  }

  /**
   * Obtiene estadísticas por departamento
   */
  async getStatsByDepartment(periodo?: string): Promise<DepartmentStats[]> {
    const data = await this.prisma.non_deductibles.findMany({
      where: {
        is_active: true,
        ...(periodo ? { periodo } : {}),
      },
      include: { departments: { select: { id: true, name: true } } },
    });

    // Agrupar por departamento
    const stats: { [key: string]: DepartmentStats } = {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data as any as NoDeducibleRow[]).forEach((item) => {
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

      stats[deptId].total_monto += Number(item.monto);
      stats[deptId].count += 1;
    });

    return Object.values(stats).sort((a, b) => b.total_monto - a.total_monto);
  }

  /**
   * Obtiene tendencia mensual
   */
  async getTrend(year?: number): Promise<PeriodTrend[]> {
    const targetYear = year || new Date().getFullYear();

    const data = await this.prisma.non_deductibles.findMany({
      where: {
        is_active: true,
        periodo: { startsWith: `${targetYear}` },
      },
      select: { periodo: true, monto: true },
    });

    // Agrupar por período
    const trends: { [key: string]: PeriodTrend } = {};

    data.forEach((item) => {
      if (!trends[item.periodo]) {
        trends[item.periodo] = {
          periodo: item.periodo,
          total: 0,
          count: 0,
        };
      }
      trends[item.periodo].total += Number(item.monto);
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
    const conceptos = await this.prisma.non_deductibles.findMany({
      where: {
        is_active: true,
        ...(periodo ? { periodo } : {}),
      },
      select: { concepto: true, monto: true },
    });

    const conceptoMap: { [key: string]: number } = {};
    conceptos.forEach((item) => {
      conceptoMap[item.concepto] = (conceptoMap[item.concepto] || 0) + Number(item.monto);
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
