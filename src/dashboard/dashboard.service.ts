import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class DashboardService {
  constructor(private readonly supabase: SupabaseService) {}

  async getSummary() {
    // Get all enrollments with course data
    const { data: enrollments } = await this.supabase.db
      .from('course_enrollments')
      .select(`
        enrolled_at,
        completed_at,
        status,
        course_editions(
          courses(duration_hours, cost)
        )
      `);

    // Count active courses
    const { count: activeCourses } = await this.supabase.db
      .from('courses')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);

    // Calculate metrics
    let totalHours = 0;
    let totalSpent = 0;
    let completedCount = 0;
    let totalDays = 0;
    let completedWithDates = 0;

    if (enrollments) {
      for (const e of enrollments as any[]) {
        const course = e.course_editions?.courses;
        if (!course) continue;

        if (e.status === 'completo') {
          totalHours += course.duration_hours || 0;
          completedCount++;

          if (e.completed_at && e.enrolled_at) {
            const enrolled = new Date(e.enrolled_at);
            const completed = new Date(e.completed_at);
            const days = Math.floor(
              (completed.getTime() - enrolled.getTime()) / (1000 * 60 * 60 * 24),
            );
            totalDays += days;
            completedWithDates++;
          }
        }

        if (['inscrito', 'en_curso', 'completo'].includes(e.status)) {
          totalSpent += course.cost || 0;
        }
      }
    }

    return {
      totalHours,
      totalSpent,
      activeCourses: activeCourses || 0,
      totalEnrolled: enrollments?.length || 0,
      completedCount,
      avgCompletionDays:
        completedWithDates > 0 ? Math.round(totalDays / completedWithDates) : 0,
    };
  }

  async getByDepartment() {
    // Get enrollments with profile and department info
    const { data: enrollments } = await this.supabase.db
      .from('course_enrollments')
      .select(`
        status,
        profiles(
          id,
          department_id,
          departments(id, name)
        ),
        course_editions(
          courses(duration_hours, cost)
        )
      `);

    // Get budgets
    const { data: budgets } = await this.supabase.db
      .from('budgets')
      .select('department_id, assigned_amount, spent_amount, departments(name)');

    // Group by department
    const deptStats: Record<
      string,
      {
        department_id: string;
        department_name: string;
        totalHours: number;
        totalSpent: number;
        enrolledCount: number;
        completedCount: number;
        budgetAssigned: number;
        budgetRemaining: number;
      }
    > = {};

    if (enrollments) {
      for (const e of enrollments as any[]) {
        const profile = e.profiles;
        const deptId = profile?.department_id;
        const deptName = profile?.departments?.name || 'Sin Área';
        const course = e.course_editions?.courses;

        if (!deptId) continue;

        if (!deptStats[deptId]) {
          deptStats[deptId] = {
            department_id: deptId,
            department_name: deptName,
            totalHours: 0,
            totalSpent: 0,
            enrolledCount: 0,
            completedCount: 0,
            budgetAssigned: 0,
            budgetRemaining: 0,
          };
        }

        deptStats[deptId].enrolledCount++;

        if (e.status === 'completo' && course) {
          deptStats[deptId].totalHours += course.duration_hours || 0;
          deptStats[deptId].completedCount++;
        }

        if (['inscrito', 'en_curso', 'completo'].includes(e.status) && course) {
          deptStats[deptId].totalSpent += course.cost || 0;
        }
      }
    }

    // Add budget info
    if (budgets) {
      for (const b of budgets as any[]) {
        if (deptStats[b.department_id]) {
          deptStats[b.department_id].budgetAssigned += b.assigned_amount || 0;
          deptStats[b.department_id].budgetRemaining +=
            (b.assigned_amount || 0) - (b.spent_amount || 0);
        } else {
          const deptName = b.departments?.name || 'Sin Área';
          deptStats[b.department_id] = {
            department_id: b.department_id,
            department_name: deptName,
            totalHours: 0,
            totalSpent: 0,
            enrolledCount: 0,
            completedCount: 0,
            budgetAssigned: b.assigned_amount || 0,
            budgetRemaining:
              (b.assigned_amount || 0) - (b.spent_amount || 0),
          };
        }
      }
    }

    return Object.values(deptStats).sort((a, b) =>
      a.department_name.localeCompare(b.department_name),
    );
  }

  async getByInstitution() {
    const { data: courses } = await this.supabase.db
      .from('courses')
      .select('id, cost, is_active, institutions(id, name)')
      .eq('is_active', true);

    // Group by institution
    const instStats: Record<
      string,
      {
        institution_id: string;
        institution_name: string;
        activeCourses: number;
        totalInvestment: number;
      }
    > = {};

    if (courses) {
      for (const c of courses as any[]) {
        const instId = c.institutions?.id || 'sin_institucion';
        const instName = c.institutions?.name || 'Sin Institución';

        if (!instStats[instId]) {
          instStats[instId] = {
            institution_id: instId,
            institution_name: instName,
            activeCourses: 0,
            totalInvestment: 0,
          };
        }

        instStats[instId].activeCourses++;
        instStats[instId].totalInvestment += c.cost || 0;
      }
    }

    return Object.values(instStats).sort(
      (a, b) => b.totalInvestment - a.totalInvestment,
    );
  }

  async getCompletionTime() {
    const { data: enrollments } = await this.supabase.db
      .from('course_enrollments')
      .select(`
        enrolled_at,
        completed_at,
        course_editions(
          courses(
            modalities(id, name)
          )
        )
      `)
      .eq('status', 'completo')
      .not('completed_at', 'is', null);

    // Group by modality
    const modalityStats: Record<
      string,
      {
        modality: string;
        totalDays: number;
        minDays: number;
        maxDays: number;
        count: number;
      }
    > = {};

    if (enrollments) {
      for (const e of enrollments as any[]) {
        const modality =
          e.course_editions?.courses?.modalities?.name || 'Sin Modalidad';
        const enrolled = new Date(e.enrolled_at);
        const completed = new Date(e.completed_at);
        const days = Math.floor(
          (completed.getTime() - enrolled.getTime()) / (1000 * 60 * 60 * 24),
        );

        if (!modalityStats[modality]) {
          modalityStats[modality] = {
            modality,
            totalDays: 0,
            minDays: Infinity,
            maxDays: 0,
            count: 0,
          };
        }

        modalityStats[modality].totalDays += days;
        modalityStats[modality].minDays = Math.min(
          modalityStats[modality].minDays,
          days,
        );
        modalityStats[modality].maxDays = Math.max(
          modalityStats[modality].maxDays,
          days,
        );
        modalityStats[modality].count++;
      }
    }

    return Object.values(modalityStats)
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
