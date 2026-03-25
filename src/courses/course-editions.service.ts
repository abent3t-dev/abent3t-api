import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateCourseEditionDto } from './dto/create-course-edition.dto';
import { UpdateCourseEditionDto } from './dto/update-course-edition.dto';

@Injectable()
export class CourseEditionsService {
  private readonly logger = new Logger(CourseEditionsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async findByCourse(courseId: string) {
    const { data, error } = await this.supabase.db
      .from('course_editions')
      .select('*')
      .eq('course_id', courseId)
      .order('start_date', { ascending: false });

    if (error) throw error;
    return data;
  }

  async findOne(courseId: string, editionId: string) {
    const { data, error } = await this.supabase.db
      .from('course_editions')
      .select('*')
      .eq('id', editionId)
      .eq('course_id', courseId)
      .single();

    if (error || !data) throw new NotFoundException('Edición no encontrada');
    return data;
  }

  private async validateCourseExists(courseId: string) {
    const { data, error } = await this.supabase.db
      .from('courses')
      .select('id, is_active')
      .eq('id', courseId)
      .single();
    if (error || !data) throw new BadRequestException('course_id: curso no encontrado');
    if (!data.is_active) throw new BadRequestException('course_id: el curso está desactivado');
  }

  async create(courseId: string, dto: CreateCourseEditionDto) {
    await this.validateCourseExists(courseId);
    const { data, error } = await this.supabase.db
      .from('course_editions')
      .insert({ ...dto, course_id: courseId })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async update(courseId: string, editionId: string, dto: UpdateCourseEditionDto) {
    const { data, error } = await this.supabase.db
      .from('course_editions')
      .update(dto)
      .eq('id', editionId)
      .eq('course_id', courseId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Edición no encontrada');
    return data;
  }

  /**
   * Cascade soft-delete:
   * 1. Cancel active enrollments on this edition (+ adjust budgets)
   * 2. Deactivate the edition
   */
  async remove(courseId: string, editionId: string) {
    // 1. Get active non-cancelled enrollments
    const { data: enrollments } = await this.supabase.db
      .from('course_enrollments')
      .select('id, profile_id, course_edition_id, status')
      .eq('course_edition_id', editionId)
      .eq('is_active', true)
      .neq('status', 'cancelado');

    if (enrollments && enrollments.length > 0) {
      const ids = enrollments.map((e: any) => e.id);

      await this.supabase.db
        .from('course_enrollments')
        .update({ is_active: false, status: 'cancelado' })
        .in('id', ids);

      // Adjust budgets (best-effort)
      for (const e of enrollments as any[]) {
        try {
          await this.adjustBudgetForCancellation(e.profile_id, editionId);
        } catch (err) {
          this.logger.error(`Failed to adjust budget for enrollment ${e.id}`, err);
        }
      }

      this.logger.log(`Cascade: cancelled ${enrollments.length} enrollments for edition ${editionId}`);
    }

    // 2. Deactivate the edition
    const { error } = await this.supabase.db
      .from('course_editions')
      .update({ is_active: false })
      .eq('id', editionId)
      .eq('course_id', courseId);

    if (error) throw error;
    return { message: 'Edición desactivada' };
  }

  private async adjustBudgetForCancellation(
    profileId: string,
    courseEditionId: string,
  ): Promise<void> {
    const { data: profile } = await this.supabase.db
      .from('profiles')
      .select('department_id')
      .eq('id', profileId)
      .single();

    if (!profile?.department_id) return;

    const { data: edition } = await this.supabase.db
      .from('course_editions')
      .select('courses(cost)')
      .eq('id', courseEditionId)
      .single();

    const cost = (edition?.courses as any)?.cost ?? 0;
    if (cost === 0) return;

    const today = new Date().toISOString().split('T')[0];
    const { data: period } = await this.supabase.db
      .from('periods')
      .select('id')
      .eq('is_active', true)
      .lte('start_date', today)
      .gte('end_date', today)
      .limit(1)
      .maybeSingle();

    if (!period) return;

    const { data: budget } = await this.supabase.db
      .from('budgets')
      .select('id, consumed_amount')
      .eq('department_id', profile.department_id)
      .eq('period_id', period.id)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (!budget) return;

    const newConsumed = Math.max(0, (Number(budget.consumed_amount) || 0) - cost);
    await this.supabase.db
      .from('budgets')
      .update({ consumed_amount: newConsumed })
      .eq('id', budget.id);
  }
}
