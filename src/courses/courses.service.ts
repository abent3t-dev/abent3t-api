import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCrudPrismaService } from '../common/services/base-crud-prisma.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

@Injectable()
export class CoursesService extends BaseCrudPrismaService<
  CreateCourseDto,
  UpdateCourseDto
> {
  protected get model() {
    return this.prisma.courses;
  }
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name', 'description'];
  protected readonly include = {
    institutions: { select: { id: true, name: true } },
    course_types: { select: { id: true, name: true } },
    modalities: { select: { id: true, name: true } },
  };
  private readonly logger = new Logger(CoursesService.name);

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  private async validateFKs(dto: CreateCourseDto | UpdateCourseDto) {
    const checks: Promise<void>[] = [];
    if (dto.institution_id)
      checks.push(
        this.validateFK(
          this.prisma.institutions,
          dto.institution_id,
          'institution_id',
        ),
      );
    if (dto.course_type_id)
      checks.push(
        this.validateFK(
          this.prisma.course_types,
          dto.course_type_id,
          'course_type_id',
        ),
      );
    if (dto.modality_id)
      checks.push(
        this.validateFK(this.prisma.modalities, dto.modality_id, 'modality_id'),
      );
    await Promise.all(checks);
  }

  /**
   * Override findAll para incluir el conteo de ediciones activas por curso.
   * Permite al frontend identificar cursos sin ediciones (no solicitables).
   */
  async findAll() {
    const courses = await this.prisma.courses.findMany({
      include: {
        ...this.include,
        course_editions: { select: { id: true, is_active: true } },
      },
      orderBy: { name: 'asc' },
    });

    return courses.map((c) => {
      const editions = c.course_editions ?? [];
      const active_editions_count = editions.filter((e) => e.is_active).length;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { course_editions: _omit, ...rest } = c;
      return { ...rest, active_editions_count };
    });
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
    const editions = await this.prisma.course_editions.findMany({
      where: { course_id: id, is_active: true },
      select: { id: true },
    });

    if (editions.length > 0) {
      const editionIds = editions.map((e) => e.id);

      const enrollments = await this.prisma.course_enrollments.findMany({
        where: {
          course_edition_id: { in: editionIds },
          is_active: true,
          status: { not: 'cancelado' },
        },
        select: { id: true, profile_id: true, course_edition_id: true },
      });

      if (enrollments.length > 0) {
        await this.prisma.course_enrollments.updateMany({
          where: { id: { in: enrollments.map((e) => e.id) } },
          data: { is_active: false, status: 'cancelado' },
        });

        for (const e of enrollments) {
          try {
            await this.adjustBudgetForCancellation(
              e.profile_id,
              e.course_edition_id,
            );
          } catch (err) {
            this.logger.error(
              `Failed to adjust budget for enrollment ${e.id}`,
              err,
            );
          }
        }

        this.logger.log(
          `Cascade: cancelled ${enrollments.length} enrollments for course ${id}`,
        );
      }

      await this.prisma.course_editions.updateMany({
        where: { id: { in: editionIds } },
        data: { is_active: false },
      });

      this.logger.log(
        `Cascade: deactivated ${editions.length} editions for course ${id}`,
      );
    }

    return super.remove(id);
  }

  /**
   * Resta el costo efectivo al `consumed_amount` del presupuesto del
   * departamento del colaborador para el período activo. Best-effort: si
   * algo no se encuentra (perfil sin departamento, sin período activo,
   * sin presupuesto, costo 0), no hace nada. Idéntico a la lógica de
   * EnrollmentsService — extraerlo a util compartido es trabajo de refactor
   * posterior; por ahora se mantiene la duplicación 1:1 con el código viejo.
   */
  private async adjustBudgetForCancellation(
    profileId: string,
    courseEditionId: string,
  ): Promise<void> {
    const profile = await this.prisma.profiles.findUnique({
      where: { id: profileId },
      select: { department_id: true },
    });
    if (!profile?.department_id) return;

    const edition = await this.prisma.course_editions.findUnique({
      where: { id: courseEditionId },
      select: { cost_override: true, courses: { select: { cost: true } } },
    });

    const baseCost = Number(edition?.courses?.cost ?? 0);
    const cost = Number(edition?.cost_override ?? baseCost);
    if (cost === 0) return;

    const today = new Date();
    const period = await this.prisma.periods.findFirst({
      where: {
        is_active: true,
        start_date: { lte: today },
        end_date: { gte: today },
      },
      select: { id: true },
    });
    if (!period) return;

    const budget = await this.prisma.budgets.findFirst({
      where: {
        department_id: profile.department_id,
        period_id: period.id,
        is_active: true,
      },
      select: { id: true, consumed_amount: true },
    });
    if (!budget) return;

    const newConsumed = Math.max(0, Number(budget.consumed_amount) - cost);
    await this.prisma.budgets.update({
      where: { id: budget.id },
      data: { consumed_amount: newConsumed },
    });
  }
}
