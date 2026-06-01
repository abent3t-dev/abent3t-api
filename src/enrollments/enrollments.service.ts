import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { BulkEnrollmentDto } from './dto/bulk-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';

const ENROLLMENT_INCLUDE = {
  profiles: {
    select: {
      id: true,
      full_name: true,
      email: true,
      position: true,
      departments: { select: { id: true, name: true } },
    },
  },
  course_editions: {
    select: {
      id: true,
      course_id: true,
      start_date: true,
      end_date: true,
      max_participants: true,
      location: true,
      instructor: true,
      require_evidence_for_completion: true,
      courses: {
        select: {
          id: true,
          name: true,
          total_hours: true,
          cost: true,
          description: true,
          course_types: { select: { id: true, name: true } },
          modalities: { select: { id: true, name: true } },
          institutions: { select: { id: true, name: true } },
        },
      },
    },
  },
} as const;

// Interface for enriched enrollment with evidence status
export interface EnrichedEnrollment {
  id: string;
  course_edition_id: string;
  profile_id: string;
  status: string;
  enrolled_at: string | Date;
  completed_at: string | Date | null;
  notes: string | null;
  is_active: boolean;
  profiles: Record<string, unknown> | null;
  course_editions: Record<string, unknown> | null;
  has_approved_evidence: boolean;
  requires_evidence: boolean;
  [key: string]: unknown;
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

  constructor(private readonly prisma: PrismaService) {}

  private async validateEditionCapacity(editionId: string, newCount = 1) {
    const edition = await this.prisma.course_editions.findUnique({
      where: { id: editionId },
      select: { max_participants: true, is_active: true },
    });

    if (!edition)
      throw new BadRequestException(
        'course_edition_id: edición no encontrada',
      );
    if (!edition.is_active)
      throw new BadRequestException(
        'course_edition_id: la edición está desactivada',
      );

    if (edition.max_participants) {
      const current = await this.prisma.course_enrollments.count({
        where: { course_edition_id: editionId, is_active: true },
      });
      if (current + newCount > edition.max_participants) {
        throw new BadRequestException(
          `La edición tiene un máximo de ${edition.max_participants} participantes (actualmente ${current})`,
        );
      }
    }
  }

  private async validateProfileExists(profileId: string) {
    const profile = await this.prisma.profiles.findUnique({
      where: { id: profileId },
      select: { id: true, is_active: true },
    });
    if (!profile)
      throw new BadRequestException('profile_id: perfil no encontrado');
    if (!profile.is_active)
      throw new BadRequestException('profile_id: el perfil está desactivado');
  }

  /**
   * Enriches enrollments with evidence status for the semaphore (A3-19).
   *   - has_approved_evidence: ≥1 evidencia con verification_status='approved'
   *   - requires_evidence: la edición tiene require_evidence_for_completion=true
   */
  private async enrichWithEvidenceStatus(
    enrollments: Array<Record<string, unknown>>,
  ): Promise<EnrichedEnrollment[]> {
    if (enrollments.length === 0) return [];

    const enrollmentIds = enrollments.map((e) => e.id as string);

    const evidences = await this.prisma.enrollment_evidences.findMany({
      where: { enrollment_id: { in: enrollmentIds }, is_active: true },
      select: { enrollment_id: true, verification_status: true },
    });

    const approvedMap = new Map<string, boolean>();
    for (const ev of evidences) {
      if (ev.verification_status === 'approved') {
        approvedMap.set(ev.enrollment_id, true);
      }
    }

    return enrollments.map((enrollment) => {
      const edition = enrollment.course_editions as Record<
        string,
        unknown
      > | null;
      return {
        ...enrollment,
        has_approved_evidence:
          approvedMap.get(enrollment.id as string) || false,
        requires_evidence:
          edition?.require_evidence_for_completion === true,
      } as EnrichedEnrollment;
    });
  }

  /**
   * Validates that the profile doesn't have any blocking enrollments (A3-19).
   * Sin diploma/evidencia aprobada, el colaborador NO puede inscribirse en
   * otro curso.
   */
  private async validateNoBlockingEnrollments(
    profileId: string,
    bypassCheck = false,
  ): Promise<void> {
    if (bypassCheck) return;

    const enrollments = await this.prisma.course_enrollments.findMany({
      where: {
        profile_id: profileId,
        is_active: true,
        status: { not: 'cancelado' },
      },
      select: {
        id: true,
        status: true,
        course_edition_id: true,
        course_editions: {
          select: {
            id: true,
            require_evidence_for_completion: true,
            courses: { select: { name: true } },
          },
        },
      },
    });

    if (enrollments.length === 0) return;

    for (const enrollment of enrollments) {
      const edition = enrollment.course_editions;
      if (!edition?.require_evidence_for_completion) continue;

      const courseName = edition.courses?.name || 'curso anterior';

      if (enrollment.status !== 'completo') {
        throw new BadRequestException(
          `El colaborador tiene una inscripción pendiente en "${courseName}". ` +
            `Debe completar el curso antes de inscribirse en otro.`,
        );
      }

      const evidences = await this.prisma.enrollment_evidences.findMany({
        where: { enrollment_id: enrollment.id, is_active: true },
        select: { verification_status: true },
      });

      const hasApprovedEvidence = evidences.some(
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
    const data = await this.prisma.course_enrollments.findMany({
      where: { is_active: true },
      include: ENROLLMENT_INCLUDE,
      orderBy: { enrolled_at: 'desc' },
    });
    return this.enrichWithEvidenceStatus(
      data as unknown as Record<string, unknown>[],
    );
  }

  async findByEdition(editionId: string) {
    const data = await this.prisma.course_enrollments.findMany({
      where: { course_edition_id: editionId, is_active: true },
      include: ENROLLMENT_INCLUDE,
      orderBy: { enrolled_at: 'desc' },
    });
    return this.enrichWithEvidenceStatus(
      data as unknown as Record<string, unknown>[],
    );
  }

  async findByProfile(profileId: string) {
    const data = await this.prisma.course_enrollments.findMany({
      where: { profile_id: profileId, is_active: true },
      include: ENROLLMENT_INCLUDE,
      orderBy: { enrolled_at: 'desc' },
    });
    return this.enrichWithEvidenceStatus(
      data as unknown as Record<string, unknown>[],
    );
  }

  /**
   * Inscripciones de todos los colaboradores de un departamento. Útil para
   * jefes de área que ven el progreso de su equipo.
   */
  async findByDepartment(departmentId: string) {
    const profiles = await this.prisma.profiles.findMany({
      where: { department_id: departmentId, is_active: true },
      select: { id: true },
    });
    if (profiles.length === 0) return [];

    const profileIds = profiles.map((p) => p.id);

    const data = await this.prisma.course_enrollments.findMany({
      where: { profile_id: { in: profileIds }, is_active: true },
      include: ENROLLMENT_INCLUDE,
      orderBy: { enrolled_at: 'desc' },
    });
    return this.enrichWithEvidenceStatus(
      data as unknown as Record<string, unknown>[],
    );
  }

  async findOne(id: string) {
    const data = await this.prisma.course_enrollments.findUnique({
      where: { id },
      include: ENROLLMENT_INCLUDE,
    });
    if (!data) throw new NotFoundException('Inscripción no encontrada');
    const enriched = await this.enrichWithEvidenceStatus([
      data as unknown as Record<string, unknown>,
    ]);
    return enriched[0];
  }

  async create(dto: CreateEnrollmentDto, bypassBlockingCheck = false) {
    await Promise.all([
      this.validateEditionCapacity(dto.course_edition_id),
      this.validateProfileExists(dto.profile_id),
      this.validateNoBlockingEnrollments(dto.profile_id, bypassBlockingCheck),
    ]);

    try {
      const data = await this.prisma.course_enrollments.create({
        data: {
          course_edition_id: dto.course_edition_id,
          profile_id: dto.profile_id,
          status: 'inscrito',
          notes: dto.notes,
        },
        include: ENROLLMENT_INCLUDE,
      });

      await this.updateBudgetConsumption(
        dto.profile_id,
        dto.course_edition_id,
        'add',
      );

      return data;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'P2002') {
        throw new ConflictException(
          'El participante ya está inscrito en esta edición',
        );
      }
      throw err;
    }
  }

  async createBulk(dto: BulkEnrollmentDto, bypassBlockingCheck = false) {
    await this.validateEditionCapacity(
      dto.course_edition_id,
      dto.profile_ids.length,
    );
    await Promise.all([
      ...dto.profile_ids.map((pid) => this.validateProfileExists(pid)),
      ...dto.profile_ids.map((pid) =>
        this.validateNoBlockingEnrollments(pid, bypassBlockingCheck),
      ),
    ]);

    try {
      // Prisma no soporta createMany con `include`; creamos primero y
      // re-leemos con include después.
      await this.prisma.course_enrollments.createMany({
        data: dto.profile_ids.map((profileId) => ({
          course_edition_id: dto.course_edition_id,
          profile_id: profileId,
          status: 'inscrito',
        })),
        skipDuplicates: false,
      });

      const data = await this.prisma.course_enrollments.findMany({
        where: {
          course_edition_id: dto.course_edition_id,
          profile_id: { in: dto.profile_ids },
        },
        include: ENROLLMENT_INCLUDE,
      });

      for (const profileId of dto.profile_ids) {
        await this.updateBudgetConsumption(
          profileId,
          dto.course_edition_id,
          'add',
        );
      }

      return data;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'P2002') {
        throw new ConflictException(
          'Algunos participantes ya están inscritos',
        );
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateEnrollmentDto) {
    const current = await this.prisma.course_enrollments.findUnique({
      where: { id },
      select: { status: true, profile_id: true, course_edition_id: true },
    });
    if (!current) throw new NotFoundException('Inscripción no encontrada');

    let previousStatus: string | null = null;
    let profileId: string | null = null;
    let editionId: string | null = null;

    if (dto.status && dto.status !== current.status) {
      const allowed =
        EnrollmentsService.VALID_TRANSITIONS[current.status] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(
          `No se puede cambiar de "${current.status}" a "${dto.status}". ` +
            `Transiciones válidas: ${allowed.join(', ') || 'ninguna'}`,
        );
      }
      if (dto.status === 'cancelado') {
        previousStatus = current.status;
        profileId = current.profile_id;
        editionId = current.course_edition_id;
      }
    }

    const updateData: Record<string, unknown> = { ...dto };
    if (dto.status === 'completo') {
      updateData.completed_at = new Date();
    }

    let data;
    try {
      data = await this.prisma.course_enrollments.update({
        where: { id },
        data: updateData as Prisma.course_enrollmentsUpdateInput,
        include: ENROLLMENT_INCLUDE,
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2025') {
        throw new NotFoundException('Inscripción no encontrada');
      }
      throw err;
    }

    if (previousStatus && profileId && editionId) {
      await this.updateBudgetConsumption(profileId, editionId, 'subtract');
    }

    return data;
  }

  async remove(id: string) {
    const current = await this.prisma.course_enrollments.findUnique({
      where: { id },
      select: {
        profile_id: true,
        course_edition_id: true,
        status: true,
      },
    });

    if (!current) throw new NotFoundException('Inscripción no encontrada');

    await this.prisma.course_enrollments.update({
      where: { id },
      data: { is_active: false, status: 'cancelado' },
    });

    if (current.status !== 'cancelado') {
      await this.updateBudgetConsumption(
        current.profile_id,
        current.course_edition_id,
        'subtract',
      );
    }

    return { message: 'Inscripción cancelada' };
  }

  /**
   * Allows a collaborator to mark their course as finished. Transición
   * inscrito|en_curso → pendiente_evidencia.
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

    const edition = enrollment.course_editions as Record<string, unknown>;
    const today = new Date().toISOString().split('T')[0];
    const startDate = edition?.start_date
      ? new Date(edition.start_date as string).toISOString().split('T')[0]
      : null;

    if (startDate && today < startDate) {
      throw new BadRequestException(
        'No puedes finalizar un curso que aún no ha comenzado',
      );
    }

    return this.prisma.course_enrollments.update({
      where: { id: enrollmentId },
      data: { status: 'pendiente_evidencia' },
      include: ENROLLMENT_INCLUDE,
    });
  }

  /**
   * Calcula el estado efectivo de una inscripción basado en fechas
   * (semáforo A3-19).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const startDate = edition?.start_date
      ? new Date(edition.start_date).toISOString().split('T')[0]
      : null;
    const endDate = edition?.end_date
      ? new Date(edition.end_date).toISOString().split('T')[0]
      : null;

    const courseStarted = startDate ? today >= startDate : false;
    const courseEnded = endDate ? today > endDate : false;

    let effectiveStatus = enrollment.status;
    if (enrollment.status === 'inscrito' && courseStarted) {
      effectiveStatus = 'en_curso';
    }
    if (
      ['inscrito', 'en_curso'].includes(enrollment.status) &&
      courseEnded
    ) {
      effectiveStatus = 'pendiente_evidencia';
    }

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
   * Actualiza consumed_amount del presupuesto al crear/cancelar una
   * inscripción. Si la edición tiene prorate_cost=true, recalcula presupuestos
   * de TODOS los departamentos.
   */
  private async updateBudgetConsumption(
    profileId: string,
    courseEditionId: string,
    operation: 'add' | 'subtract',
  ): Promise<void> {
    try {
      const edition = await this.prisma.course_editions.findUnique({
        where: { id: courseEditionId },
        select: {
          course_id: true,
          prorate_cost: true,
          cost_override: true,
          courses: { select: { cost: true } },
        },
      });

      const baseCost = Number(edition?.courses?.cost ?? 0);
      const effectiveCost = Number(edition?.cost_override ?? baseCost);
      if (effectiveCost === 0) return;

      if (edition?.prorate_cost) {
        await this.recalculateProratedBudgets(courseEditionId, effectiveCost);
        return;
      }

      const profile = await this.prisma.profiles.findUnique({
        where: { id: profileId },
        select: { department_id: true },
      });

      if (!profile?.department_id) {
        this.logger.warn(
          `Profile ${profileId} has no department — skipping budget update`,
        );
        return;
      }

      const today = new Date();
      const period = await this.prisma.periods.findFirst({
        where: {
          is_active: true,
          start_date: { lte: today },
          end_date: { gte: today },
        },
        select: { id: true },
      });
      if (!period) {
        this.logger.warn(
          `No active period found for date ${today.toISOString()} — skipping budget update`,
        );
        return;
      }

      const budget = await this.prisma.budgets.findFirst({
        where: {
          department_id: profile.department_id,
          period_id: period.id,
          is_active: true,
        },
        select: { id: true, consumed_amount: true },
      });
      if (!budget) {
        this.logger.warn(
          `No budget for department ${profile.department_id} / period ${period.id} — skipping`,
        );
        return;
      }

      const currentConsumed = Number(budget.consumed_amount);
      const newConsumed =
        operation === 'add'
          ? currentConsumed + effectiveCost
          : Math.max(0, currentConsumed - effectiveCost);

      await this.prisma.budgets.update({
        where: { id: budget.id },
        data: { consumed_amount: newConsumed },
      });

      this.logger.log(
        `Budget ${budget.id}: consumed_amount ${currentConsumed} → ${newConsumed} (${operation} ${effectiveCost})`,
      );
    } catch (err) {
      this.logger.error('Failed to update budget consumption', err);
    }
  }

  /**
   * Recalcula consumed_amount para TODOS los departamentos con participantes
   * en una edición con prorate_cost=true. Fórmula A3-16.
   */
  private async recalculateProratedBudgets(
    courseEditionId: string,
    courseCost: number,
  ): Promise<void> {
    try {
      const enrollments = await this.prisma.course_enrollments.findMany({
        where: {
          course_edition_id: courseEditionId,
          is_active: true,
          status: { not: 'cancelado' },
        },
        select: {
          id: true,
          profile_id: true,
          profiles: { select: { department_id: true } },
        },
      });

      if (enrollments.length === 0) {
        this.logger.log(
          `No active enrollments for edition ${courseEditionId} — skipping proration`,
        );
        return;
      }

      const today = new Date();
      const period = await this.prisma.periods.findFirst({
        where: {
          is_active: true,
          start_date: { lte: today },
          end_date: { gte: today },
        },
        select: { id: true },
      });
      if (!period) {
        this.logger.warn(
          `No active period found for date ${today.toISOString()} — skipping proration`,
        );
        return;
      }

      const departmentCounts: Record<string, number> = {};
      for (const enrollment of enrollments) {
        const deptId = enrollment.profiles?.department_id;
        if (deptId) {
          departmentCounts[deptId] = (departmentCounts[deptId] || 0) + 1;
        }
      }

      const totalParticipants = enrollments.length;
      const costPerPerson = courseCost / totalParticipants;

      this.logger.log(
        `Proration: ${courseCost} / ${totalParticipants} participants = ${costPerPerson.toFixed(2)} per person`,
      );

      for (const [deptId, count] of Object.entries(departmentCounts)) {
        const deptCost = costPerPerson * count;

        const budget = await this.prisma.budgets.findFirst({
          where: {
            department_id: deptId,
            period_id: period.id,
            is_active: true,
          },
          select: { id: true },
        });

        if (!budget) {
          this.logger.warn(
            `No budget for department ${deptId} / period ${period.id} — skipping`,
          );
          continue;
        }

        await this.prisma.budgets.update({
          where: { id: budget.id },
          data: { consumed_amount: deptCost },
        });

        this.logger.log(
          `Budget ${budget.id} (dept ${deptId}): prorated cost = ${deptCost.toFixed(2)} (${count} participants × ${costPerPerson.toFixed(2)})`,
        );
      }
    } catch (err) {
      this.logger.error('Failed to recalculate prorated budgets', err);
    }
  }
}
