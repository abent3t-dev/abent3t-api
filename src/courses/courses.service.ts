import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BaseCrudService } from '../common/services/base-crud.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

@Injectable()
export class CoursesService extends BaseCrudService<CreateCourseDto, UpdateCourseDto> {
  protected readonly tableName = 'courses';
  protected readonly selectFields = '*, institutions(id, name), course_types(id, name), modalities(id, name)';
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name', 'description'];
  private readonly logger = new Logger(CoursesService.name);

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  private async validateFKs(dto: CreateCourseDto | UpdateCourseDto) {
    const checks: Promise<void>[] = [];
    if (dto.institution_id) checks.push(this.validateFK('institutions', dto.institution_id, 'institution_id'));
    if (dto.course_type_id) checks.push(this.validateFK('course_types', dto.course_type_id, 'course_type_id'));
    if (dto.modality_id) checks.push(this.validateFK('modalities', dto.modality_id, 'modality_id'));
    await Promise.all(checks);
  }

  async create(dto: CreateCourseDto) {
    await this.validateFKs(dto);
    return super.create(dto);
  }

  async update(id: string, dto: UpdateCourseDto) {
    await this.validateFKs(dto);
    return super.update(id, dto);
  }

  /**
   * Cascade soft-delete:
   * 1. Cancel active enrollments on active editions (+ adjust budgets)
   * 2. Deactivate active editions
   * 3. Deactivate the course
   */
  async remove(id: string): Promise<{ message: string }> {
    // 1. Get active editions
    const { data: editions } = await this.supabase.db
      .from('course_editions')
      .select('id')
      .eq('course_id', id)
      .eq('is_active', true);

    if (editions && editions.length > 0) {
      const editionIds = editions.map((e: any) => e.id);

      // 2. Get active non-cancelled enrollments on those editions
      const { data: enrollments } = await this.supabase.db
        .from('course_enrollments')
        .select('id, profile_id, course_edition_id, status')
        .in('course_edition_id', editionIds)
        .eq('is_active', true)
        .neq('status', 'cancelado');

      // 3. Cancel those enrollments + adjust budgets
      if (enrollments && enrollments.length > 0) {
        const enrollmentIds = enrollments.map((e: any) => e.id);

        await this.supabase.db
          .from('course_enrollments')
          .update({ is_active: false, status: 'cancelado' })
          .in('id', enrollmentIds);

        // Adjust budgets (best-effort, don't block)
        for (const e of enrollments as any[]) {
          try {
            await this.adjustBudgetForCancellation(e.profile_id, e.course_edition_id);
          } catch (err) {
            this.logger.error(`Failed to adjust budget for enrollment ${e.id}`, err);
          }
        }

        this.logger.log(`Cascade: cancelled ${enrollments.length} enrollments for course ${id}`);
      }

      // 4. Deactivate editions
      await this.supabase.db
        .from('course_editions')
        .update({ is_active: false })
        .in('id', editionIds);

      this.logger.log(`Cascade: deactivated ${editions.length} editions for course ${id}`);
    }

    // 5. Deactivate the course itself
    return super.remove(id);
  }

  /**
   * Replicates the budget subtraction logic from EnrollmentsService.
   * Kept separate to avoid circular dependency.
   * Uses effective cost: edition.cost_override ?? course.cost
   */
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
      .select('cost_override, courses(cost)')
      .eq('id', courseEditionId)
      .single();

    // Effective cost: edition override takes precedence over course base cost
    const baseCost = (edition?.courses as any)?.cost ?? 0;
    const cost = edition?.cost_override ?? baseCost;
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
