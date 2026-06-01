import {
  Injectable,
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCourseEditionDto } from './dto/create-course-edition.dto';
import { UpdateCourseEditionDto } from './dto/update-course-edition.dto';

@Injectable()
export class CourseEditionsService {
  private readonly logger = new Logger(CourseEditionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findByCourse(courseId: string) {
    return this.prisma.course_editions.findMany({
      where: { course_id: courseId },
      orderBy: { start_date: 'desc' },
    });
  }

  async findOne(courseId: string, editionId: string) {
    const edition = await this.prisma.course_editions.findFirst({
      where: { id: editionId, course_id: courseId },
    });
    if (!edition) throw new NotFoundException('Edición no encontrada');
    return edition;
  }

  private async validateCourseExists(courseId: string) {
    const course = await this.prisma.courses.findUnique({
      where: { id: courseId },
      select: { id: true, is_active: true },
    });
    if (!course)
      throw new BadRequestException('course_id: curso no encontrado');
    if (!course.is_active)
      throw new BadRequestException('course_id: el curso está desactivado');
  }

  async create(courseId: string, dto: CreateCourseEditionDto) {
    await this.validateCourseExists(courseId);
    return this.prisma.course_editions.create({
      data: {
        ...dto,
        course_id: courseId,
      } as unknown as Parameters<
        typeof this.prisma.course_editions.create
      >[0]['data'],
    });
  }

  async update(
    courseId: string,
    editionId: string,
    dto: UpdateCourseEditionDto,
  ) {
    // Verificar que la edición exista bajo ese course_id
    const existing = await this.prisma.course_editions.findFirst({
      where: { id: editionId, course_id: courseId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Edición no encontrada');

    return this.prisma.course_editions.update({
      where: { id: editionId },
      data: dto as unknown as Parameters<
        typeof this.prisma.course_editions.update
      >[0]['data'],
    });
  }

  /**
   * Cascade soft-delete:
   * 1. Cancel active enrollments on this edition (+ adjust budgets)
   * 2. Deactivate the edition
   */
  async remove(courseId: string, editionId: string) {
    const enrollments = await this.prisma.course_enrollments.findMany({
      where: {
        course_edition_id: editionId,
        is_active: true,
        status: { not: 'cancelado' },
      },
      select: { id: true, profile_id: true },
    });

    if (enrollments.length > 0) {
      await this.prisma.course_enrollments.updateMany({
        where: { id: { in: enrollments.map((e) => e.id) } },
        data: { is_active: false, status: 'cancelado' },
      });

      for (const e of enrollments) {
        try {
          await this.adjustBudgetForCancellation(e.profile_id, editionId);
        } catch (err) {
          this.logger.error(
            `Failed to adjust budget for enrollment ${e.id}`,
            err,
          );
        }
      }
      this.logger.log(
        `Cascade: cancelled ${enrollments.length} enrollments for edition ${editionId}`,
      );
    }

    // Verificar pertenencia antes de desactivar
    const exists = await this.prisma.course_editions.findFirst({
      where: { id: editionId, course_id: courseId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Edición no encontrada');

    await this.prisma.course_editions.update({
      where: { id: editionId },
      data: { is_active: false },
    });
    return { message: 'Edición desactivada' };
  }

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
