import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { BulkEnrollmentDto } from './dto/bulk-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';

const ENROLLMENT_SELECT = `
  *,
  profiles(id, full_name, email, position, departments(id, name)),
  course_editions(
    id, course_id, start_date, end_date, max_participants, location, instructor,
    require_evidence_for_completion,
    courses(
      id, name, total_hours, cost, description,
      course_types(id, name),
      modalities(id, name),
      institutions(id, name)
    )
  )
`;

// Interface for enriched enrollment with evidence status
interface EnrichedEnrollment {
  [key: string]: unknown;
  has_approved_evidence: boolean;
  requires_evidence: boolean;
}

@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger(EnrollmentsService.name);

  private static readonly VALID_TRANSITIONS: Record<string, string[]> = {
    inscrito: ['en_curso', 'cancelado'],
    en_curso: ['completo', 'pendiente_evidencia', 'cancelado'],
    pendiente_evidencia: ['completo', 'cancelado'],
    completo: [],
    cancelado: [],
  };

  constructor(private readonly supabase: SupabaseService) {}

  private async validateEditionCapacity(editionId: string, newCount = 1) {
    const { data: edition } = await this.supabase.db
      .from('course_editions')
      .select('max_participants, is_active')
      .eq('id', editionId)
      .single();

    if (!edition) throw new BadRequestException('course_edition_id: edición no encontrada');
    if (!edition.is_active) throw new BadRequestException('course_edition_id: la edición está desactivada');

    if (edition.max_participants) {
      const { count } = await this.supabase.db
        .from('course_enrollments')
        .select('id', { count: 'exact', head: true })
        .eq('course_edition_id', editionId)
        .eq('is_active', true);

      const current = count ?? 0;
      if (current + newCount > edition.max_participants) {
        throw new BadRequestException(
          `La edición tiene un máximo de ${edition.max_participants} participantes (actualmente ${current})`,
        );
      }
    }
  }

  private async validateProfileExists(profileId: string) {
    const { data } = await this.supabase.db
      .from('profiles')
      .select('id, is_active')
      .eq('id', profileId)
      .single();

    if (!data) throw new BadRequestException('profile_id: perfil no encontrado');
    if (!data.is_active) throw new BadRequestException('profile_id: el perfil está desactivado');
  }

  /**
   * Enriches enrollments with evidence status for the semaphore
   * - has_approved_evidence: true if there's at least one approved evidence
   * - requires_evidence: true if the edition requires evidence for completion
   */
  private async enrichWithEvidenceStatus(
    enrollments: Record<string, unknown>[],
  ): Promise<EnrichedEnrollment[]> {
    if (!enrollments || enrollments.length === 0) return [];

    const enrollmentIds = enrollments.map((e) => e.id as string);

    // Get all evidences for these enrollments in one query
    const { data: evidences } = await this.supabase.db
      .from('enrollment_evidences')
      .select('enrollment_id, verification_status')
      .in('enrollment_id', enrollmentIds)
      .eq('is_active', true);

    // Create a map of enrollment_id -> has_approved_evidence
    const approvedMap = new Map<string, boolean>();
    if (evidences) {
      for (const ev of evidences) {
        if (ev.verification_status === 'approved') {
          approvedMap.set(ev.enrollment_id, true);
        }
      }
    }

    // Enrich each enrollment
    return enrollments.map((enrollment) => {
      const edition = enrollment.course_editions as Record<string, unknown> | null;
      return {
        ...enrollment,
        has_approved_evidence: approvedMap.get(enrollment.id as string) || false,
        requires_evidence: edition?.require_evidence_for_completion === true,
      } as EnrichedEnrollment;
    });
  }

  /**
   * Validates that the profile doesn't have any blocking enrollments.
   * A blocking enrollment is one where:
   * - Edition has require_evidence_for_completion = true
   * - Status is NOT 'cancelado' or 'completo'
   * - OR status is 'completo' but has no approved evidence
   *
   * Rule: Sin diploma/evidencia aprobada, el colaborador NO puede
   *       inscribirse en otro curso.
   */
  private async validateNoBlockingEnrollments(
    profileId: string,
    bypassCheck = false,
  ): Promise<void> {
    if (bypassCheck) return;

    // Get all active enrollments for this profile that require evidence
    const { data: enrollments } = await this.supabase.db
      .from('course_enrollments')
      .select(`
        id,
        status,
        course_edition_id,
        course_editions!inner(
          id,
          require_evidence_for_completion,
          courses(name)
        )
      `)
      .eq('profile_id', profileId)
      .eq('is_active', true)
      .neq('status', 'cancelado');

    if (!enrollments || enrollments.length === 0) return;

    // Check each enrollment
    for (const enrollment of enrollments) {
      const edition = enrollment.course_editions as any;

      // Skip if edition doesn't require evidence
      if (!edition?.require_evidence_for_completion) continue;

      const courseName = edition?.courses?.name || 'curso anterior';

      // If enrollment is not complete, it's blocking
      if (enrollment.status !== 'completo') {
        throw new BadRequestException(
          `El colaborador tiene una inscripción pendiente en "${courseName}". ` +
          `Debe completar el curso antes de inscribirse en otro.`,
        );
      }

      // If enrollment is complete, check for approved evidence
      const { data: evidences } = await this.supabase.db
        .from('enrollment_evidences')
        .select('id, verification_status')
        .eq('enrollment_id', enrollment.id)
        .eq('is_active', true);

      const hasApprovedEvidence = evidences?.some(
        (e) => e.verification_status === 'approved',
      );

      if (!hasApprovedEvidence) {
        throw new BadRequestException(
          `El colaborador completó "${courseName}" pero no tiene evidencia aprobada. ` +
          `Sin diploma/evidencia aprobada no puede inscribirse en otro curso.`,
        );
      }
    }
  }

  async findAll() {
    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .select(ENROLLMENT_SELECT)
      .eq('is_active', true)
      .order('enrolled_at', { ascending: false });

    if (error) throw error;
    return this.enrichWithEvidenceStatus(data || []);
  }

  async findByEdition(editionId: string) {
    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .select(ENROLLMENT_SELECT)
      .eq('course_edition_id', editionId)
      .eq('is_active', true)
      .order('enrolled_at', { ascending: false });

    if (error) throw error;
    return this.enrichWithEvidenceStatus(data || []);
  }

  async findByProfile(profileId: string) {
    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .select(ENROLLMENT_SELECT)
      .eq('profile_id', profileId)
      .eq('is_active', true)
      .order('enrolled_at', { ascending: false });

    if (error) throw error;
    return this.enrichWithEvidenceStatus(data || []);
  }

  /**
   * Obtiene inscripciones de todos los colaboradores de un departamento
   * Útil para que jefes de área vean el progreso de su equipo
   */
  async findByDepartment(departmentId: string) {
    // Primero obtenemos los profile_ids del departamento
    const { data: profiles, error: profilesError } = await this.supabase.db
      .from('profiles')
      .select('id')
      .eq('department_id', departmentId)
      .eq('is_active', true);

    if (profilesError) throw profilesError;
    if (!profiles || profiles.length === 0) return [];

    const profileIds = profiles.map((p) => p.id);

    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .select(ENROLLMENT_SELECT)
      .in('profile_id', profileIds)
      .eq('is_active', true)
      .order('enrolled_at', { ascending: false });

    if (error) throw error;
    return this.enrichWithEvidenceStatus(data || []);
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .select(ENROLLMENT_SELECT)
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException('Inscripción no encontrada');
    }

    const enriched = await this.enrichWithEvidenceStatus([data]);
    return enriched[0];
  }

  async create(dto: CreateEnrollmentDto, bypassBlockingCheck = false) {
    await Promise.all([
      this.validateEditionCapacity(dto.course_edition_id),
      this.validateProfileExists(dto.profile_id),
      this.validateNoBlockingEnrollments(dto.profile_id, bypassBlockingCheck),
    ]);

    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .insert({
        course_edition_id: dto.course_edition_id,
        profile_id: dto.profile_id,
        status: dto.status || 'inscrito',
        notes: dto.notes,
      })
      .select(ENROLLMENT_SELECT)
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'El participante ya está inscrito en esta edición',
        );
      }
      throw error;
    }

    await this.updateBudgetConsumption(
      dto.profile_id,
      dto.course_edition_id,
      'add',
    );

    return data;
  }

  async createBulk(dto: BulkEnrollmentDto, bypassBlockingCheck = false) {
    await this.validateEditionCapacity(dto.course_edition_id, dto.profile_ids.length);
    await Promise.all([
      ...dto.profile_ids.map((pid) => this.validateProfileExists(pid)),
      ...dto.profile_ids.map((pid) => this.validateNoBlockingEnrollments(pid, bypassBlockingCheck)),
    ]);

    const enrollments = dto.profile_ids.map((profileId) => ({
      course_edition_id: dto.course_edition_id,
      profile_id: profileId,
      status: 'inscrito',
    }));

    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .insert(enrollments)
      .select(ENROLLMENT_SELECT);

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'Algunos participantes ya están inscritos',
        );
      }
      throw error;
    }

    for (const profileId of dto.profile_ids) {
      await this.updateBudgetConsumption(
        profileId,
        dto.course_edition_id,
        'add',
      );
    }

    return data;
  }

  async update(id: string, dto: UpdateEnrollmentDto) {
    // Always fetch current state for transition validation + budget tracking
    const { data: current } = await this.supabase.db
      .from('course_enrollments')
      .select('status, profile_id, course_edition_id')
      .eq('id', id)
      .single();

    if (!current) throw new NotFoundException('Inscripción no encontrada');

    // Validate state transition
    let previousStatus: string | null = null;
    let profileId: string | null = null;
    let editionId: string | null = null;

    if (dto.status && dto.status !== current.status) {
      const currentStatus = current.status as string;
      const allowed = EnrollmentsService.VALID_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(
          `No se puede cambiar de "${currentStatus}" a "${dto.status}". Transiciones válidas: ${allowed.join(', ') || 'ninguna'}`,
        );
      }
      if (dto.status === 'cancelado') {
        previousStatus = currentStatus;
        profileId = current.profile_id as string;
        editionId = current.course_edition_id as string;
      }
    }

    const updateData: Record<string, unknown> = { ...dto };
    if (dto.status === 'completo') {
      updateData.completed_at = new Date().toISOString();
    }

    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .update(updateData)
      .eq('id', id)
      .select(ENROLLMENT_SELECT)
      .single();

    if (error || !data) {
      throw new NotFoundException('Inscripción no encontrada');
    }

    // Subtract budget if status changed to cancelado
    if (previousStatus && profileId && editionId) {
      await this.updateBudgetConsumption(profileId, editionId, 'subtract');
    }

    return data;
  }

  async remove(id: string) {
    // Fetch enrollment data before removing to update budget
    const { data: current } = await this.supabase.db
      .from('course_enrollments')
      .select('profile_id, course_edition_id, status')
      .eq('id', id)
      .single();

    const { error } = await this.supabase.db
      .from('course_enrollments')
      .update({ is_active: false, status: 'cancelado' })
      .eq('id', id);

    if (error) throw error;

    if (current && current.status !== 'cancelado') {
      await this.updateBudgetConsumption(
        current.profile_id as string,
        current.course_edition_id as string,
        'subtract',
      );
    }

    return { message: 'Inscripción cancelada' };
  }

  /**
   * Allows a collaborator to mark their course as finished.
   * Changes status from 'inscrito' or 'en_curso' to 'pendiente_evidencia'.
   */
  async finishCourse(enrollmentId: string) {
    const enrollment = await this.findOne(enrollmentId);

    const allowedStatuses = ['inscrito', 'en_curso'];
    if (!allowedStatuses.includes(enrollment.status)) {
      throw new BadRequestException(
        `No puedes finalizar un curso con estado "${enrollment.status}". ` +
        `Solo se puede finalizar cursos con estado: ${allowedStatuses.join(', ')}`,
      );
    }

    // Check if course has started based on dates
    const edition = enrollment.course_editions as any;
    const today = new Date().toISOString().split('T')[0];

    if (edition?.start_date && today < edition.start_date) {
      throw new BadRequestException(
        'No puedes finalizar un curso que aún no ha comenzado',
      );
    }

    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .update({ status: 'pendiente_evidencia' })
      .eq('id', enrollmentId)
      .select(ENROLLMENT_SELECT)
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Calculates the effective status of an enrollment based on dates.
   * - If status is 'inscrito' and today >= start_date: effective = 'en_curso'
   * - If status is 'inscrito'/'en_curso' and today > end_date: effective = 'pendiente_evidencia'
   * - Otherwise returns the actual status
   */
  getEffectiveStatus(enrollment: any): {
    status: string;
    effectiveStatus: string;
    canFinish: boolean;
    canUploadEvidence: boolean;
    courseStarted: boolean;
    courseEnded: boolean;
  } {
    const edition = enrollment.course_editions;
    const today = new Date().toISOString().split('T')[0];
    const startDate = edition?.start_date;
    const endDate = edition?.end_date;

    const courseStarted = startDate ? today >= startDate : false;
    const courseEnded = endDate ? today > endDate : false;

    let effectiveStatus = enrollment.status;

    // If enrolled and course has started, effective status is 'en_curso'
    if (enrollment.status === 'inscrito' && courseStarted) {
      effectiveStatus = 'en_curso';
    }

    // If course has ended and not yet finished, effective status is 'pendiente_evidencia'
    if (['inscrito', 'en_curso'].includes(enrollment.status) && courseEnded) {
      effectiveStatus = 'pendiente_evidencia';
    }

    // Determine available actions
    const canFinish =
      ['inscrito', 'en_curso'].includes(enrollment.status) &&
      courseStarted &&
      !courseEnded;

    const canUploadEvidence =
      effectiveStatus === 'pendiente_evidencia' ||
      enrollment.status === 'pendiente_evidencia' ||
      enrollment.status === 'completo';

    return {
      status: enrollment.status,
      effectiveStatus,
      canFinish,
      canUploadEvidence,
      courseStarted,
      courseEnded,
    };
  }

  /**
   * Updates the consumed_amount on the matching budget when an enrollment
   * is created or cancelled.
   *
   * If prorate_cost is enabled on the edition, recalculates budgets for ALL
   * departments with participants in the edition.
   *
   * Budget lookup: department of the enrolled profile + period whose
   * date range contains today.
   */
  private async updateBudgetConsumption(
    profileId: string,
    courseEditionId: string,
    operation: 'add' | 'subtract',
  ): Promise<void> {
    try {
      // Check if edition has prorate_cost enabled
      const { data: edition } = await this.supabase.db
        .from('course_editions')
        .select('course_id, prorate_cost, courses(cost)')
        .eq('id', courseEditionId)
        .single();

      const cost = (edition?.courses as any)?.cost ?? 0;
      if (cost === 0) return;

      // If prorate_cost is enabled, recalculate ALL department budgets
      if (edition?.prorate_cost) {
        await this.recalculateProratedBudgets(courseEditionId, cost);
        return;
      }

      // Original logic for non-prorated enrollments
      // 1. Get profile's department
      const { data: profile } = await this.supabase.db
        .from('profiles')
        .select('department_id')
        .eq('id', profileId)
        .single();

      if (!profile?.department_id) {
        this.logger.warn(
          `Profile ${profileId} has no department — skipping budget update`,
        );
        return;
      }

      // 2. Find current active period (today falls between start/end)
      const today = new Date().toISOString().split('T')[0];

      const { data: period } = await this.supabase.db
        .from('periods')
        .select('id')
        .eq('is_active', true)
        .lte('start_date', today)
        .gte('end_date', today)
        .limit(1)
        .single();

      if (!period) {
        this.logger.warn(
          `No active period found for date ${today} — skipping budget update`,
        );
        return;
      }

      // 3. Find budget for department + period
      const { data: budget } = await this.supabase.db
        .from('budgets')
        .select('id, consumed_amount')
        .eq('department_id', profile.department_id)
        .eq('period_id', period.id)
        .eq('is_active', true)
        .limit(1)
        .single();

      if (!budget) {
        this.logger.warn(
          `No budget for department ${profile.department_id} / period ${period.id} — skipping`,
        );
        return;
      }

      // 4. Update consumed_amount
      const currentConsumed = Number(budget.consumed_amount) || 0;
      const newConsumed =
        operation === 'add'
          ? currentConsumed + cost
          : Math.max(0, currentConsumed - cost);

      await this.supabase.db
        .from('budgets')
        .update({ consumed_amount: newConsumed })
        .eq('id', budget.id);

      this.logger.log(
        `Budget ${budget.id}: consumed_amount ${currentConsumed} → ${newConsumed} (${operation} ${cost})`,
      );
    } catch (err) {
      // Never block enrollment due to budget errors
      this.logger.error('Failed to update budget consumption', err);
    }
  }

  /**
   * Recalculates budget consumption for ALL departments with participants
   * in a prorated edition.
   *
   * Formula: cost_per_person = course_cost / total_participants
   * Each department pays: cost_per_person * participants_from_department
   *
   * This is called whenever a participant is added or removed from a
   * prorated edition.
   */
  private async recalculateProratedBudgets(
    courseEditionId: string,
    courseCost: number,
  ): Promise<void> {
    try {
      // 1. Get all active enrollments with profile department info
      const { data: enrollments } = await this.supabase.db
        .from('course_enrollments')
        .select('id, profile_id, profiles(department_id)')
        .eq('course_edition_id', courseEditionId)
        .eq('is_active', true)
        .neq('status', 'cancelado');

      if (!enrollments || enrollments.length === 0) {
        this.logger.log(
          `No active enrollments for edition ${courseEditionId} — skipping proration`,
        );
        return;
      }

      // 2. Find current active period
      const today = new Date().toISOString().split('T')[0];
      const { data: period } = await this.supabase.db
        .from('periods')
        .select('id')
        .eq('is_active', true)
        .lte('start_date', today)
        .gte('end_date', today)
        .limit(1)
        .single();

      if (!period) {
        this.logger.warn(
          `No active period found for date ${today} — skipping proration`,
        );
        return;
      }

      // 3. Count participants per department
      const departmentCounts: Record<string, number> = {};
      for (const enrollment of enrollments) {
        const deptId = (enrollment.profiles as any)?.department_id;
        if (deptId) {
          departmentCounts[deptId] = (departmentCounts[deptId] || 0) + 1;
        }
      }

      // 4. Calculate prorated cost per person
      const totalParticipants = enrollments.length;
      const costPerPerson = courseCost / totalParticipants;

      this.logger.log(
        `Proration: ${courseCost} / ${totalParticipants} participants = ${costPerPerson.toFixed(2)} per person`,
      );

      // 5. Update budget for each department
      for (const [deptId, count] of Object.entries(departmentCounts)) {
        const deptCost = costPerPerson * count;

        // Get current budget
        const { data: budget } = await this.supabase.db
          .from('budgets')
          .select('id, consumed_amount')
          .eq('department_id', deptId)
          .eq('period_id', period.id)
          .eq('is_active', true)
          .limit(1)
          .single();

        if (!budget) {
          this.logger.warn(
            `No budget for department ${deptId} / period ${period.id} — skipping`,
          );
          continue;
        }

        // Note: For proper proration tracking, we'd need to store previous
        // proration values. For now, we recalculate based on current state.
        // This assumes the budget's consumed_amount is updated atomically.
        await this.supabase.db
          .from('budgets')
          .update({ consumed_amount: deptCost })
          .eq('id', budget.id);

        this.logger.log(
          `Budget ${budget.id} (dept ${deptId}): prorated cost = ${deptCost.toFixed(2)} (${count} participants × ${costPerPerson.toFixed(2)})`,
        );
      }
    } catch (err) {
      this.logger.error('Failed to recalculate prorated budgets', err);
    }
  }
}
