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
  course_editions(id, course_id, start_date, end_date, max_participants, courses(id, name))
`;

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

  async findAll() {
    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .select(ENROLLMENT_SELECT)
      .eq('is_active', true)
      .order('enrolled_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  async findByEdition(editionId: string) {
    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .select(ENROLLMENT_SELECT)
      .eq('course_edition_id', editionId)
      .eq('is_active', true)
      .order('enrolled_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  async findByProfile(profileId: string) {
    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .select(ENROLLMENT_SELECT)
      .eq('profile_id', profileId)
      .eq('is_active', true)
      .order('enrolled_at', { ascending: false });

    if (error) throw error;
    return data;
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
    return data;
  }

  async create(dto: CreateEnrollmentDto) {
    await Promise.all([
      this.validateEditionCapacity(dto.course_edition_id),
      this.validateProfileExists(dto.profile_id),
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

  async createBulk(dto: BulkEnrollmentDto) {
    await this.validateEditionCapacity(dto.course_edition_id, dto.profile_ids.length);
    await Promise.all(dto.profile_ids.map((pid) => this.validateProfileExists(pid)));

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
   * Updates the consumed_amount on the matching budget when an enrollment
   * is created or cancelled.
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

      // 2. Get course cost via edition → course
      const { data: edition } = await this.supabase.db
        .from('course_editions')
        .select('course_id, courses(cost)')
        .eq('id', courseEditionId)
        .single();

      const cost = (edition?.courses as any)?.cost ?? 0;
      if (cost === 0) return;

      // 3. Find current active period (today falls between start/end)
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

      // 4. Find budget for department + period
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

      // 5. Update consumed_amount
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
}
