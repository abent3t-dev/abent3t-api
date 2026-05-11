import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export interface KpiValue {
  value: number;
  formatted: string;
  subtitle: string;
}

interface Period {
  id: string;
  label: string;
  year: number;
  semester: number | null;
  start_date: string;
  end_date: string;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(private readonly supabase: SupabaseService) {}

  // ── helpers ──────────────────────────────────────────────

  private formatCurrency(n: number): string {
    return `$${n.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }

  private pct(numerator: number, denominator: number): number {
    return denominator > 0
      ? Math.round((numerator / denominator) * 1000) / 10
      : 0;
  }

  private async getCurrentPeriod(): Promise<Period | null> {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await this.supabase.db
      .from('periods')
      .select('id, label, year, semester, start_date, end_date')
      .eq('is_active', true)
      .lte('start_date', today)
      .gte('end_date', today)
      .limit(1)
      .maybeSingle();
    return data as Period | null;
  }

  /**
   * Returns all active enrollments whose edition start_date falls inside the
   * given period range.  Joins profiles, course_editions→courses for metrics.
   */
  private async getEnrollmentsForPeriod(period: Period) {
    const { data } = await this.supabase.db
      .from('course_enrollments')
      .select(`
        id, status, enrolled_at, completed_at, profile_id,
        profiles(id, department_id),
        course_editions!inner(
          id, start_date,
          courses(id, total_hours, cost)
        )
      `)
      .eq('is_active', true)
      .gte('course_editions.start_date', period.start_date)
      .lte('course_editions.start_date', period.end_date);

    return (data ?? []) as any[];
  }

  // ── KPI calculators ──────────────────────────────────────

  /**
   * Calcula la ejecución presupuestal del periodo.
   *
   * `totalAssigned` viene de `budgets.assigned_amount` (lo que admin_rh dejó
   * configurado). `totalConsumed` se calcula a partir de los costos vigentes
   * de las inscripciones, NO de `budgets.consumed_amount`.
   *
   * Por qué: `consumed_amount` se actualiza transaccionalmente al inscribir /
   * cancelar, pero puede divergir del costo real cuando cambia el costo del
   * curso o cuando el prorrateo no se recalcula. Si se usa la fuente
   * almacenada, la card "Ejecución" y la columna "Gastado" del desglose por
   * área dejan de cuadrar — el cliente reportó exactamente ese síntoma. Al
   * calcular siempre desde las inscripciones, todos los números del dashboard
   * usan la misma fuente de verdad y cuadran entre sí.
   */
  private calculateBudgetExecution(
    enrollments: any[],
    budgets: any[],
  ): KpiValue {
    let totalAssigned = 0;
    for (const b of budgets) {
      totalAssigned += Number(b.assigned_amount) || 0;
    }
    let totalConsumed = 0;
    for (const e of enrollments) {
      if (e.status === 'cancelado') continue;
      totalConsumed += Number(e.course_editions?.courses?.cost) || 0;
    }

    const pct = this.pct(totalConsumed, totalAssigned);

    return {
      value: pct,
      formatted: `${pct}%`,
      subtitle: `${this.formatCurrency(totalConsumed)} de ${this.formatCurrency(totalAssigned)} asignados`,
    };
  }

  private calculateInvestmentPerEmployee(
    enrollments: any[],
  ): KpiValue {
    const profileCosts = new Map<string, number>();
    for (const e of enrollments) {
      if (e.status === 'cancelado') continue;
      const cost = Number(e.course_editions?.courses?.cost) || 0;
      const pid = e.profile_id as string;
      profileCosts.set(pid, (profileCosts.get(pid) || 0) + cost);
    }

    const totalCost = [...profileCosts.values()].reduce((a, b) => a + b, 0);
    const count = profileCosts.size;
    const avg = count > 0 ? Math.round(totalCost / count) : 0;

    return {
      value: avg,
      formatted: this.formatCurrency(avg),
      subtitle: `${count} colaboradores capacitados`,
    };
  }

  private calculateHoursPerEmployee(enrollments: any[]): KpiValue {
    const profileHours = new Map<string, number>();
    let totalCompleted = 0;

    for (const e of enrollments) {
      if (e.status !== 'completo') continue;
      totalCompleted++;
      const hours = Number(e.course_editions?.courses?.total_hours) || 0;
      const pid = e.profile_id as string;
      profileHours.set(pid, (profileHours.get(pid) || 0) + hours);
    }

    const totalHours = [...profileHours.values()].reduce((a, b) => a + b, 0);
    const count = profileHours.size;
    const avg = count > 0 ? Math.round((totalHours / count) * 10) / 10 : 0;

    return {
      value: avg,
      formatted: `${avg} hrs`,
      subtitle: `${totalCompleted} cursos completados en total`,
    };
  }

  private async calculateCoverageRate(
    enrollments: any[],
  ): Promise<KpiValue> {
    // Unique profiles with at least 1 non-cancelled enrollment in period
    const enrolledProfiles = new Set<string>();
    for (const e of enrollments) {
      if (e.status !== 'cancelado') enrolledProfiles.add(e.profile_id);
    }

    // Total active employees
    const { count: totalActive } = await this.supabase.db
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true);

    const total = totalActive ?? 0;
    const enrolled = enrolledProfiles.size;
    const pct = this.pct(enrolled, total);

    return {
      value: pct,
      formatted: `${pct}%`,
      subtitle: `${enrolled} de ${total} colaboradores`,
    };
  }

  private calculateCompletionRate(enrollments: any[]): KpiValue {
    let completed = 0;
    let nonCancelled = 0;

    for (const e of enrollments) {
      if (e.status === 'cancelado') continue;
      nonCancelled++;
      if (e.status === 'completo') completed++;
    }

    const pct = this.pct(completed, nonCancelled);

    return {
      value: pct,
      formatted: `${pct}%`,
      subtitle: `${completed} completados de ${nonCancelled} inscritos`,
    };
  }

  // ── public endpoints ─────────────────────────────────────

  async getSummary() {
    const period = await this.getCurrentPeriod();

    if (!period) {
      const empty: KpiValue = { value: 0, formatted: '—', subtitle: 'Sin datos' };
      return {
        period: null,
        kpis: {
          budgetExecution: empty,
          investmentPerEmployee: empty,
          hoursPerEmployee: empty,
          coverageRate: empty,
          completionRate: empty,
        },
      };
    }

    const enrollments = await this.getEnrollmentsForPeriod(period);
    const { data: budgetsRaw } = await this.supabase.db
      .from('budgets')
      .select('assigned_amount')
      .eq('period_id', period.id)
      .eq('is_active', true);
    const budgets = (budgetsRaw ?? []) as any[];

    const coverageRate = await this.calculateCoverageRate(enrollments);
    const budgetExecution = this.calculateBudgetExecution(enrollments, budgets);

    return {
      period: {
        id: period.id,
        label: period.label,
        year: period.year,
        semester: period.semester,
      },
      kpis: {
        budgetExecution,
        investmentPerEmployee: this.calculateInvestmentPerEmployee(enrollments),
        hoursPerEmployee: this.calculateHoursPerEmployee(enrollments),
        coverageRate,
        completionRate: this.calculateCompletionRate(enrollments),
      },
    };
  }

  async getByDepartment() {
    const period = await this.getCurrentPeriod();
    if (!period) return [];

    const enrollments = await this.getEnrollmentsForPeriod(period);

    // `consumed_amount` ya no se lee aquí — el "Disponible" se calcula como
    // `assigned_amount - totalSpent` (con totalSpent agregado de las
    // inscripciones del periodo), garantizando que las columnas Gastado y
    // Disponible siempre cuadren entre sí.
    const { data: budgets } = await this.supabase.db
      .from('budgets')
      .select('department_id, assigned_amount, departments(name)')
      .eq('period_id', period.id)
      .eq('is_active', true);

    // Group enrollments by department
    const stats: Record<string, {
      department_id: string;
      department_name: string;
      totalHours: number;
      totalSpent: number;
      enrolledCount: number;
      completedCount: number;
      budgetAssigned: number;
      budgetRemaining: number;
    }> = {};

    for (const e of enrollments) {
      const deptId = e.profiles?.department_id;
      if (!deptId || e.status === 'cancelado') continue;

      if (!stats[deptId]) {
        stats[deptId] = {
          department_id: deptId,
          department_name: '',
          totalHours: 0, totalSpent: 0,
          enrolledCount: 0, completedCount: 0,
          budgetAssigned: 0, budgetRemaining: 0,
        };
      }

      stats[deptId].enrolledCount++;
      const cost = Number(e.course_editions?.courses?.cost) || 0;
      stats[deptId].totalSpent += cost;

      if (e.status === 'completo') {
        stats[deptId].completedCount++;
        stats[deptId].totalHours += Number(e.course_editions?.courses?.total_hours) || 0;
      }
    }

    // Merge budget data
    for (const b of (budgets ?? []) as any[]) {
      const deptId = b.department_id;
      if (!stats[deptId]) {
        stats[deptId] = {
          department_id: deptId,
          department_name: b.departments?.name || 'Sin Área',
          totalHours: 0, totalSpent: 0,
          enrolledCount: 0, completedCount: 0,
          budgetAssigned: 0, budgetRemaining: 0,
        };
      }
      stats[deptId].department_name = b.departments?.name || stats[deptId].department_name || 'Sin Área';
      stats[deptId].budgetAssigned += Number(b.assigned_amount) || 0;
    }

    // Disponible = asignado - gastado (con gastado calculado desde inscripciones).
    // Hacerlo en una segunda pasada deja el cálculo independiente del orden
    // en que se procesen budgets vs enrollments arriba.
    for (const s of Object.values(stats)) {
      s.budgetRemaining = s.budgetAssigned - s.totalSpent;
    }

    // Fill missing department names from enrollments
    if (Object.values(stats).some((s) => !s.department_name)) {
      const { data: depts } = await this.supabase.db
        .from('departments')
        .select('id, name');
      const deptMap = new Map((depts ?? []).map((d: any) => [d.id, d.name]));
      for (const s of Object.values(stats)) {
        if (!s.department_name) s.department_name = deptMap.get(s.department_id) || 'Sin Área';
      }
    }

    return Object.values(stats).sort((a, b) => a.department_name.localeCompare(b.department_name));
  }

  async getByInstitution() {
    const { data: courses } = await this.supabase.db
      .from('courses')
      .select('id, cost, is_active, institutions(id, name)')
      .eq('is_active', true);

    const stats: Record<string, {
      institution_id: string;
      institution_name: string;
      activeCourses: number;
      totalInvestment: number;
    }> = {};

    for (const c of (courses ?? []) as any[]) {
      const id = c.institutions?.id || 'sin_institucion';
      const name = c.institutions?.name || 'Sin Institución';
      if (!stats[id]) stats[id] = { institution_id: id, institution_name: name, activeCourses: 0, totalInvestment: 0 };
      stats[id].activeCourses++;
      stats[id].totalInvestment += Number(c.cost) || 0;
    }

    return Object.values(stats).sort((a, b) => b.totalInvestment - a.totalInvestment);
  }

  async getCompletionTime() {
    const { data: enrollments } = await this.supabase.db
      .from('course_enrollments')
      .select(`
        enrolled_at, completed_at,
        course_editions(courses(modalities(id, name)))
      `)
      .eq('status', 'completo')
      .not('completed_at', 'is', null);

    const stats: Record<string, { modality: string; totalDays: number; minDays: number; maxDays: number; count: number }> = {};

    for (const e of (enrollments ?? []) as any[]) {
      const modality = e.course_editions?.courses?.modalities?.name || 'Sin Modalidad';
      const days = Math.floor(
        (new Date(e.completed_at).getTime() - new Date(e.enrolled_at).getTime()) / 86_400_000,
      );
      if (!stats[modality]) stats[modality] = { modality, totalDays: 0, minDays: Infinity, maxDays: 0, count: 0 };
      stats[modality].totalDays += days;
      stats[modality].minDays = Math.min(stats[modality].minDays, days);
      stats[modality].maxDays = Math.max(stats[modality].maxDays, days);
      stats[modality].count++;
    }

    return Object.values(stats)
      .map((m) => ({
        modality: m.modality,
        avgDays: m.count > 0 ? Math.round(m.totalDays / m.count) : 0,
        minDays: m.minDays === Infinity ? 0 : m.minDays,
        maxDays: m.maxDays,
        count: m.count,
      }))
      .sort((a, b) => b.count - a.count);
  }
}
