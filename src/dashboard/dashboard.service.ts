import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
  start_date: Date | string;
  end_date: Date | string;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    const today = new Date();
    const data = await this.prisma.periods.findFirst({
      where: {
        is_active: true,
        start_date: { lte: today },
        end_date: { gte: today },
      },
      select: {
        id: true,
        label: true,
        year: true,
        semester: true,
        start_date: true,
        end_date: true,
      },
    });
    return data as Period | null;
  }

  /**
   * Returns all active enrollments whose edition start_date falls inside the
   * given period range.  Joins profiles, course_editions→courses for metrics.
   *
   * Si `scopeDeptId` se provee, filtra al departamento dado (usado para
   * scopear las vistas de jefe_area / director a su propia área).
   */
  private async getEnrollmentsForPeriod(
    period: Period,
    scopeDeptId?: string,
  ) {
    const data = await this.prisma.course_enrollments.findMany({
      where: {
        is_active: true,
        course_editions: {
          start_date: {
            gte: new Date(period.start_date),
            lte: new Date(period.end_date),
          },
        },
        ...(scopeDeptId
          ? { profiles: { department_id: scopeDeptId } }
          : {}),
      },
      select: {
        id: true,
        status: true,
        enrolled_at: true,
        completed_at: true,
        profile_id: true,
        profiles: { select: { id: true, department_id: true } },
        course_editions: {
          select: {
            id: true,
            start_date: true,
            courses: {
              select: { id: true, total_hours: true, cost: true },
            },
          },
        },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data as any[];
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    enrollments: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    enrollments: any[],
    scopeDeptId?: string,
  ): Promise<KpiValue> {
    // Unique profiles with at least 1 non-cancelled enrollment in period
    const enrolledProfiles = new Set<string>();
    for (const e of enrollments) {
      if (e.status !== 'cancelado') enrolledProfiles.add(e.profile_id);
    }

    // Total active employees (filtrado por departamento si está scoped)
    const totalActive = await this.prisma.profiles.count({
      where: {
        is_active: true,
        ...(scopeDeptId ? { department_id: scopeDeptId } : {}),
      },
    });

    const total = totalActive ?? 0;
    const enrolled = enrolledProfiles.size;
    const pct = this.pct(enrolled, total);

    return {
      value: pct,
      formatted: `${pct}%`,
      subtitle: `${enrolled} de ${total} colaboradores`,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  async getSummary(scopeDeptId?: string) {
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

    const enrollments = await this.getEnrollmentsForPeriod(period, scopeDeptId);

    const budgetsRaw = await this.prisma.budgets.findMany({
      where: {
        period_id: period.id,
        is_active: true,
        ...(scopeDeptId ? { department_id: scopeDeptId } : {}),
      },
      select: { assigned_amount: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const budgets = (budgetsRaw ?? []) as any[];

    const coverageRate = await this.calculateCoverageRate(
      enrollments,
      scopeDeptId,
    );
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

  async getByDepartment(scopeDeptId?: string) {
    const period = await this.getCurrentPeriod();
    if (!period) return [];

    const enrollments = await this.getEnrollmentsForPeriod(period, scopeDeptId);

    // `consumed_amount` ya no se lee aquí — el "Disponible" se calcula como
    // `assigned_amount - totalSpent` (con totalSpent agregado de las
    // inscripciones del periodo), garantizando que las columnas Gastado y
    // Disponible siempre cuadren entre sí.
    const budgets = await this.prisma.budgets.findMany({
      where: {
        period_id: period.id,
        is_active: true,
        ...(scopeDeptId ? { department_id: scopeDeptId } : {}),
      },
      select: {
        department_id: true,
        assigned_amount: true,
        departments: { select: { name: true } },
      },
    });

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      const depts = await this.prisma.departments.findMany({
        select: { id: true, name: true },
      });
      const deptMap = new Map((depts ?? []).map((d) => [d.id, d.name]));
      for (const s of Object.values(stats)) {
        if (!s.department_name) s.department_name = deptMap.get(s.department_id) || 'Sin Área';
      }
    }

    return Object.values(stats).sort((a, b) => a.department_name.localeCompare(b.department_name));
  }

  async getByInstitution() {
    const courses = await this.prisma.courses.findMany({
      where: { is_active: true },
      select: {
        id: true,
        cost: true,
        is_active: true,
        institutions: { select: { id: true, name: true } },
      },
    });

    const stats: Record<string, {
      institution_id: string;
      institution_name: string;
      activeCourses: number;
      totalInvestment: number;
    }> = {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const enrollments = await this.prisma.course_enrollments.findMany({
      where: {
        status: 'completo',
        completed_at: { not: null },
      },
      select: {
        enrolled_at: true,
        completed_at: true,
        course_editions: {
          select: {
            courses: {
              select: {
                modalities: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    const stats: Record<string, { modality: string; totalDays: number; minDays: number; maxDays: number; count: number }> = {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
