import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

interface ReportFilters {
  period_id?: string;
  department_id?: string;
  institution_id?: string;
  year?: number;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Reporte por persona: horas e inversión por colaborador
   */
  async getByPerson(filters: ReportFilters) {
    let query = this.supabase.db
      .from('course_enrollments')
      .select(`
        id,
        status,
        enrolled_at,
        completed_at,
        profile_id,
        profiles!inner(
          id,
          full_name,
          email,
          position,
          department_id,
          departments(id, name)
        ),
        course_editions!inner(
          id,
          start_date,
          cost_override,
          courses!inner(
            id,
            name,
            total_hours,
            cost,
            institution_id,
            institutions(id, name)
          )
        )
      `)
      .eq('is_active', true)
      .neq('status', 'cancelado');

    if (filters.department_id) {
      query = query.eq('profiles.department_id', filters.department_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Agrupar por persona
    const byPerson: Record<string, any> = {};

    for (const enrollment of data || []) {
      const profile = enrollment.profiles as any;
      const edition = enrollment.course_editions as any;
      const course = edition?.courses as any;

      if (!profile?.id) continue;

      if (!byPerson[profile.id]) {
        byPerson[profile.id] = {
          profile_id: profile.id,
          full_name: profile.full_name,
          email: profile.email,
          position: profile.position,
          department: profile.departments?.name || 'Sin área',
          total_hours: 0,
          completed_hours: 0,
          total_investment: 0,
          courses_enrolled: 0,
          courses_completed: 0,
        };
      }

      const hours = course?.total_hours || 0;
      // Costo efectivo: usa cost_override de la edición si existe, sino el costo base del curso
      const effectiveCost = edition?.cost_override ?? course?.cost ?? 0;

      byPerson[profile.id].courses_enrolled += 1;
      byPerson[profile.id].total_investment += effectiveCost;

      if (enrollment.status === 'completo') {
        byPerson[profile.id].courses_completed += 1;
        byPerson[profile.id].completed_hours += hours;
      }
      byPerson[profile.id].total_hours += hours;
    }

    return Object.values(byPerson).sort((a: any, b: any) =>
      a.full_name.localeCompare(b.full_name)
    );
  }

  /**
   * Reporte por departamento: horas e inversión por área
   */
  async getByDepartment(filters: ReportFilters) {
    // Obtener presupuestos
    let budgetQuery = this.supabase.db
      .from('budgets')
      .select(`
        id,
        department_id,
        period_id,
        assigned_amount,
        consumed_amount,
        departments(id, name),
        periods(id, year, semester, label)
      `)
      .eq('is_active', true);

    if (filters.period_id) {
      budgetQuery = budgetQuery.eq('period_id', filters.period_id);
    }

    const { data: budgets, error: budgetError } = await budgetQuery;
    if (budgetError) throw budgetError;

    // Obtener inscripciones para calcular horas
    let enrollmentQuery = this.supabase.db
      .from('course_enrollments')
      .select(`
        id,
        status,
        profile_id,
        profiles!inner(department_id),
        course_editions!inner(
          cost_override,
          courses!inner(total_hours, cost)
        )
      `)
      .eq('is_active', true)
      .neq('status', 'cancelado');

    const { data: enrollments, error: enrollmentError } = await enrollmentQuery;
    if (enrollmentError) throw enrollmentError;

    // Agrupar horas por departamento
    const hoursByDept: Record<string, { total: number; completed: number; enrolled: number; completed_count: number }> = {};

    for (const e of enrollments || []) {
      const deptId = (e.profiles as any)?.department_id;
      const hours = (e.course_editions as any)?.courses?.total_hours || 0;

      if (!deptId) continue;

      if (!hoursByDept[deptId]) {
        hoursByDept[deptId] = { total: 0, completed: 0, enrolled: 0, completed_count: 0 };
      }

      hoursByDept[deptId].enrolled += 1;
      hoursByDept[deptId].total += hours;

      if (e.status === 'completo') {
        hoursByDept[deptId].completed += hours;
        hoursByDept[deptId].completed_count += 1;
      }
    }

    // Combinar presupuestos con horas
    const result = (budgets || []).map((b: any) => {
      const deptId = b.department_id;
      const hoursData = hoursByDept[deptId] || { total: 0, completed: 0, enrolled: 0, completed_count: 0 };
      const assigned = Number(b.assigned_amount) || 0;
      const consumed = Number(b.consumed_amount) || 0;

      return {
        department_id: deptId,
        department_name: b.departments?.name || 'Sin nombre',
        period: b.periods?.label || `${b.periods?.year}-${b.periods?.semester}`,
        period_id: b.period_id,
        assigned_amount: assigned,
        consumed_amount: consumed,
        available_amount: assigned - consumed,
        execution_percentage: assigned > 0 ? Math.round((consumed / assigned) * 100) : 0,
        total_hours: hoursData.total,
        completed_hours: hoursData.completed,
        courses_enrolled: hoursData.enrolled,
        courses_completed: hoursData.completed_count,
      };
    });

    return result.sort((a, b) => a.department_name.localeCompare(b.department_name));
  }

  /**
   * Reporte por institución: cursos e inversión por proveedor
   */
  async getByInstitution(filters: ReportFilters) {
    const { data: enrollments, error } = await this.supabase.db
      .from('course_enrollments')
      .select(`
        id,
        status,
        course_editions!inner(
          cost_override,
          courses!inner(
            id,
            name,
            cost,
            total_hours,
            institution_id,
            institutions(id, name, type)
          )
        )
      `)
      .eq('is_active', true)
      .neq('status', 'cancelado');

    if (error) throw error;

    // Agrupar por institución
    const byInstitution: Record<string, any> = {};

    for (const e of enrollments || []) {
      const edition = e.course_editions as any;
      const course = edition?.courses;
      const institution = course?.institutions;

      if (!institution?.id) continue;

      if (!byInstitution[institution.id]) {
        byInstitution[institution.id] = {
          institution_id: institution.id,
          institution_name: institution.name,
          institution_type: institution.type,
          total_investment: 0,
          total_hours: 0,
          courses_count: new Set(),
          enrollments_count: 0,
          completed_count: 0,
        };
      }

      // Costo efectivo: usa cost_override de la edición si existe, sino el costo base del curso
      const effectiveCost = edition?.cost_override ?? course?.cost ?? 0;
      byInstitution[institution.id].total_investment += effectiveCost;
      byInstitution[institution.id].total_hours += course.total_hours || 0;
      byInstitution[institution.id].courses_count.add(course.id);
      byInstitution[institution.id].enrollments_count += 1;

      if (e.status === 'completo') {
        byInstitution[institution.id].completed_count += 1;
      }
    }

    return Object.values(byInstitution)
      .map((inst: any) => ({
        ...inst,
        courses_count: inst.courses_count.size,
      }))
      .sort((a: any, b: any) => b.total_investment - a.total_investment);
  }

  /**
   * Reporte comparativo por período
   */
  async getByPeriod() {
    // Obtener todos los períodos
    const { data: periods, error: periodError } = await this.supabase.db
      .from('periods')
      .select('*')
      .eq('is_active', true)
      .order('year', { ascending: false })
      .order('semester', { ascending: false });

    if (periodError) throw periodError;

    // Obtener presupuestos agrupados por período
    const { data: budgets, error: budgetError } = await this.supabase.db
      .from('budgets')
      .select('period_id, assigned_amount, consumed_amount')
      .eq('is_active', true);

    if (budgetError) throw budgetError;

    // Obtener inscripciones con fechas
    const { data: enrollments, error: enrollmentError } = await this.supabase.db
      .from('course_enrollments')
      .select(`
        id,
        status,
        enrolled_at,
        course_editions!inner(
          start_date,
          cost_override,
          courses!inner(total_hours, cost)
        )
      `)
      .eq('is_active', true)
      .neq('status', 'cancelado');

    if (enrollmentError) throw enrollmentError;

    // Calcular métricas por período
    const result = (periods || []).map((period: any) => {
      // Sumar presupuestos del período
      const periodBudgets = (budgets || []).filter((b: any) => b.period_id === period.id);
      const totalAssigned = periodBudgets.reduce((sum: number, b: any) => sum + (Number(b.assigned_amount) || 0), 0);
      const totalConsumed = periodBudgets.reduce((sum: number, b: any) => sum + (Number(b.consumed_amount) || 0), 0);

      // Filtrar inscripciones del período (por fecha de inicio del curso)
      const periodEnrollments = (enrollments || []).filter((e: any) => {
        const startDate = new Date((e.course_editions as any)?.start_date);
        const periodStart = new Date(period.start_date);
        const periodEnd = new Date(period.end_date);
        return startDate >= periodStart && startDate <= periodEnd;
      });

      const totalHours = periodEnrollments.reduce((sum: number, e: any) => {
        return sum + ((e.course_editions as any)?.courses?.total_hours || 0);
      }, 0);

      // Calcular inversión total usando costo efectivo
      const totalInvestment = periodEnrollments.reduce((sum: number, e: any) => {
        const edition = e.course_editions as any;
        const effectiveCost = edition?.cost_override ?? edition?.courses?.cost ?? 0;
        return sum + effectiveCost;
      }, 0);

      const completedCount = periodEnrollments.filter((e: any) => e.status === 'completo').length;

      return {
        period_id: period.id,
        period_label: period.label || `${period.year}-${period.semester}`,
        year: period.year,
        semester: period.semester,
        total_assigned: totalAssigned,
        total_consumed: totalConsumed,
        total_available: totalAssigned - totalConsumed,
        execution_percentage: totalAssigned > 0 ? Math.round((totalConsumed / totalAssigned) * 100) : 0,
        total_enrollments: periodEnrollments.length,
        completed_enrollments: completedCount,
        completion_rate: periodEnrollments.length > 0 ? Math.round((completedCount / periodEnrollments.length) * 100) : 0,
        total_hours: totalHours,
        total_investment: totalInvestment,
      };
    });

    return result;
  }

  /**
   * Exportar datos en formato CSV
   */
  async exportToCSV(type: 'person' | 'department' | 'institution' | 'period', filters: ReportFilters): Promise<string> {
    let data: any[];
    let headers: string[];

    switch (type) {
      case 'person':
        data = await this.getByPerson(filters);
        headers = ['Nombre', 'Email', 'Puesto', 'Departamento', 'Cursos Inscritos', 'Cursos Completados', 'Horas Totales', 'Horas Completadas', 'Inversión Total'];
        return this.generateCSV(data, headers, [
          'full_name', 'email', 'position', 'department', 'courses_enrolled', 'courses_completed', 'total_hours', 'completed_hours', 'total_investment'
        ]);

      case 'department':
        data = await this.getByDepartment(filters);
        headers = ['Departamento', 'Período', 'Presupuesto Asignado', 'Presupuesto Consumido', 'Disponible', '% Ejecución', 'Horas Totales', 'Horas Completadas', 'Cursos Inscritos', 'Cursos Completados'];
        return this.generateCSV(data, headers, [
          'department_name', 'period', 'assigned_amount', 'consumed_amount', 'available_amount', 'execution_percentage', 'total_hours', 'completed_hours', 'courses_enrolled', 'courses_completed'
        ]);

      case 'institution':
        data = await this.getByInstitution(filters);
        headers = ['Institución', 'Tipo', 'Cursos', 'Inscripciones', 'Completados', 'Horas Totales', 'Inversión Total'];
        return this.generateCSV(data, headers, [
          'institution_name', 'institution_type', 'courses_count', 'enrollments_count', 'completed_count', 'total_hours', 'total_investment'
        ]);

      case 'period':
        data = await this.getByPeriod();
        headers = ['Período', 'Año', 'Semestre', 'Presupuesto Asignado', 'Presupuesto Consumido', 'Disponible', '% Ejecución', 'Inscripciones', 'Completados', '% Completación', 'Horas Totales'];
        return this.generateCSV(data, headers, [
          'period_label', 'year', 'semester', 'total_assigned', 'total_consumed', 'total_available', 'execution_percentage', 'total_enrollments', 'completed_enrollments', 'completion_rate', 'total_hours'
        ]);

      default:
        throw new Error('Tipo de reporte no válido');
    }
  }

  private generateCSV(data: any[], headers: string[], fields: string[]): string {
    const rows = [headers.join(',')];

    for (const item of data) {
      const row = fields.map(field => {
        const value = item[field];
        // Escapar comillas y envolver en comillas si contiene comas
        if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value ?? '';
      });
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }
}
