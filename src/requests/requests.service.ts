import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { SocketService } from '../socket/socket.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { ReviewRequestDto } from './dto/review-request.dto';

const REQUEST_INCLUDE = {
  profiles_training_requests_profile_idToprofiles: {
    select: {
      id: true,
      full_name: true,
      email: true,
      position: true,
      department_id: true,
      departments: { select: { id: true, name: true } },
    },
  },
  profiles_training_requests_requested_byToprofiles: {
    select: { id: true, full_name: true, email: true },
  },
  profiles_training_requests_reviewed_byToprofiles: {
    select: { id: true, full_name: true },
  },
  course_editions: {
    select: {
      id: true,
      start_date: true,
      end_date: true,
      location: true,
      instructor: true,
      cost_override: true,
      courses: {
        select: {
          id: true,
          name: true,
          cost: true,
          total_hours: true,
          institutions: { select: { name: true } },
          modalities: { select: { name: true } },
        },
      },
    },
  },
} as const;

/**
 * Adapta el include de Prisma al shape que el frontend espera (claves
 * `profiles`, `requester`, `reviewer`). Mantiene retro-compatibilidad sin
 * cambios en el front.
 */
function aliasRequest<T extends Record<string, unknown>>(row: T): T {
  if (!row) return row;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = row as any;
  return {
    ...row,
    profiles: r.profiles_training_requests_profile_idToprofiles ?? null,
    requester: r.profiles_training_requests_requested_byToprofiles ?? null,
    reviewer: r.profiles_training_requests_reviewed_byToprofiles ?? null,
  } as T;
}

@Injectable()
export class RequestsService {
  private readonly logger = new Logger(RequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrollmentsService: EnrollmentsService,
    private readonly socketService: SocketService,
  ) {}

  /** Get all requests (for admin_rh) with pagination */
  async findAll(status?: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const where: Prisma.training_requestsWhereInput = { is_active: true };
    if (status) where.status = status as Prisma.training_requestsWhereInput['status'];

    const [data, total] = await this.prisma.$transaction([
      this.prisma.training_requests.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.training_requests.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;
    return {
      data: data.map((r) => aliasRequest(r as unknown as Record<string, unknown>)),
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  async findPending() {
    return this.findAll('pendiente');
  }

  async getStats(userId?: string, userRole?: string) {
    const where: Prisma.training_requestsWhereInput = { is_active: true };
    if (
      userId &&
      userRole &&
      !['admin_rh', 'super_admin'].includes(userRole)
    ) {
      if (['jefe_area', 'director'].includes(userRole)) {
        where.requested_by = userId;
      } else {
        where.profile_id = userId;
      }
    }

    const data = await this.prisma.training_requests.findMany({
      where,
      select: { status: true },
    });

    return {
      total: data.length,
      pendientes: data.filter((r) => r.status === 'pendiente').length,
      aprobadas: data.filter((r) => r.status === 'aprobada').length,
      rechazadas: data.filter((r) => r.status === 'rechazada').length,
    };
  }

  async findByRequester(requesterId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const where: Prisma.training_requestsWhereInput = {
      requested_by: requesterId,
      is_active: true,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.training_requests.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.training_requests.count({ where }),
    ]);
    const totalPages = Math.ceil(total / limit) || 1;
    return {
      data: data.map((r) => aliasRequest(r as unknown as Record<string, unknown>)),
      meta: { total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
    };
  }

  async findByBeneficiary(profileId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const where: Prisma.training_requestsWhereInput = {
      profile_id: profileId,
      is_active: true,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.training_requests.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.training_requests.count({ where }),
    ]);
    const totalPages = Math.ceil(total / limit) || 1;
    return {
      data: data.map((r) => aliasRequest(r as unknown as Record<string, unknown>)),
      meta: { total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
    };
  }

  /** Get requests for profiles in a specific department */
  async findByDepartment(departmentId: string) {
    const data = await this.prisma.training_requests.findMany({
      where: {
        is_active: true,
        profiles_training_requests_profile_idToprofiles: {
          department_id: departmentId,
        },
      },
      include: REQUEST_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    return data.map((r) => aliasRequest(r as unknown as Record<string, unknown>));
  }

  async findOne(id: string) {
    const data = await this.prisma.training_requests.findUnique({
      where: { id },
      include: REQUEST_INCLUDE,
    });
    if (!data) throw new NotFoundException('Solicitud no encontrada');
    return aliasRequest(data as unknown as Record<string, unknown>);
  }

  /**
   * Create a new training request (by jefe_area).
   */
  async create(
    dto: CreateRequestDto,
    requestedBy: string,
    requesterDepartmentId: string | null,
  ) {
    const profile = await this.prisma.profiles.findUnique({
      where: { id: dto.profile_id },
      select: {
        id: true,
        full_name: true,
        department_id: true,
        is_active: true,
      },
    });
    if (!profile) throw new BadRequestException('El colaborador no existe');
    if (!profile.is_active)
      throw new BadRequestException('El colaborador está desactivado');

    if (
      requesterDepartmentId &&
      profile.department_id !== requesterDepartmentId
    ) {
      throw new ForbiddenException(
        'Solo puedes solicitar capacitación para colaboradores de tu área',
      );
    }

    const edition = await this.prisma.course_editions.findUnique({
      where: { id: dto.course_edition_id },
      select: {
        id: true,
        is_active: true,
        courses: { select: { name: true } },
      },
    });
    if (!edition) throw new BadRequestException('La edición del curso no existe');
    if (!edition.is_active)
      throw new BadRequestException('La edición del curso no está activa');

    const existingEnrollment = await this.prisma.course_enrollments.findFirst({
      where: {
        course_edition_id: dto.course_edition_id,
        profile_id: dto.profile_id,
        is_active: true,
      },
      select: { id: true },
    });
    if (existingEnrollment) {
      throw new ConflictException(
        'El colaborador ya está inscrito en esta edición',
      );
    }

    const existingRequest = await this.prisma.training_requests.findFirst({
      where: {
        course_edition_id: dto.course_edition_id,
        profile_id: dto.profile_id,
        status: 'pendiente',
        is_active: true,
      },
      select: { id: true },
    });
    if (existingRequest) {
      throw new ConflictException(
        'Ya existe una solicitud pendiente para este colaborador y curso',
      );
    }

    const created = await this.prisma.training_requests.create({
      data: {
        course_edition_id: dto.course_edition_id,
        profile_id: dto.profile_id,
        requested_by: requestedBy,
        request_reason: dto.request_reason,
        status: 'pendiente',
      },
      include: REQUEST_INCLUDE,
    });

    const data = aliasRequest(created as unknown as Record<string, unknown>);
    this.logger.log(
      `Request created: ${profile.full_name} for ${edition.courses?.name}`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aliased: any = data;
    this.socketService.emitRequest(
      'create',
      {
        id: aliased.id,
        requesterId: requestedBy,
        requesterName: aliased.requester?.full_name || '',
        profileId: dto.profile_id,
        profileName: profile.full_name ?? '',
        courseName: edition.courses?.name || '',
        departmentId: profile.department_id ?? undefined,
      },
      { id: requestedBy, name: aliased.requester?.full_name || '' },
    );

    return data;
  }

  /** Review (approve/reject) a request (by admin_rh) */
  async review(id: string, dto: ReviewRequestDto, reviewedBy: string) {
    const request = await this.prisma.training_requests.findFirst({
      where: { id, is_active: true },
      select: {
        id: true,
        status: true,
        course_edition_id: true,
        profile_id: true,
      },
    });
    if (!request) throw new NotFoundException('Solicitud no encontrada');

    if (request.status !== 'pendiente') {
      throw new BadRequestException(`La solicitud ya fue ${request.status}`);
    }

    // === REJECT ===
    if (dto.status === 'rechazada') {
      if (!dto.rejection_reason) {
        throw new BadRequestException(
          'Debe proporcionar un motivo de rechazo',
        );
      }

      const updated = await this.prisma.training_requests.update({
        where: { id },
        data: {
          status: 'rechazada',
          rejection_reason: dto.rejection_reason,
          reviewed_by: reviewedBy,
          reviewed_at: new Date(),
        },
        include: REQUEST_INCLUDE,
      });
      const data = aliasRequest(updated as unknown as Record<string, unknown>);

      this.logger.log(`Request ${id} rejected: ${dto.rejection_reason}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aliased: any = data;
      this.socketService.emitRequest(
        'reject',
        {
          id: aliased.id,
          requesterId: aliased.requested_by,
          requesterName: aliased.requester?.full_name || '',
          profileId: aliased.profiles?.id,
          profileName: aliased.profiles?.full_name || '',
          courseName: aliased.course_editions?.courses?.name || '',
          departmentId: aliased.profiles?.department_id ?? undefined,
        },
        { id: reviewedBy, name: '' },
      );

      return data;
    }

    // === APPROVE ===
    const enrollment = await this.enrollmentsService.create(
      {
        course_edition_id: request.course_edition_id,
        profile_id: request.profile_id,
      },
      true, // bypass blocking check (admin_rh approving)
    );

    const updated = await this.prisma.training_requests.update({
      where: { id },
      data: {
        status: 'aprobada',
        reviewed_by: reviewedBy,
        reviewed_at: new Date(),
        enrollment_id: enrollment.id,
      },
      include: REQUEST_INCLUDE,
    });
    const data = aliasRequest(updated as unknown as Record<string, unknown>);

    this.logger.log(
      `Request ${id} approved, enrollment ${enrollment.id} created`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aliased: any = data;
    this.socketService.emitRequest(
      'approve',
      {
        id: aliased.id,
        requesterId: aliased.requested_by,
        requesterName: aliased.requester?.full_name || '',
        profileId: aliased.profiles?.id,
        profileName: aliased.profiles?.full_name || '',
        courseName: aliased.course_editions?.courses?.name || '',
        departmentId: aliased.profiles?.department_id ?? undefined,
      },
      { id: reviewedBy, name: '' },
    );
    this.socketService.emitDashboardRefresh();

    return data;
  }

  /** Cancel a request (by the requester, only if pending) */
  async cancel(id: string, cancelledBy: string) {
    const request = await this.prisma.training_requests.findFirst({
      where: { id, is_active: true },
      select: { id: true, status: true, requested_by: true },
    });
    if (!request) throw new NotFoundException('Solicitud no encontrada');

    if (request.requested_by !== cancelledBy) {
      throw new ForbiddenException('Solo el solicitante puede cancelar');
    }
    if (request.status !== 'pendiente') {
      throw new BadRequestException(
        `No se puede cancelar una solicitud ${request.status}`,
      );
    }

    await this.prisma.training_requests.update({
      where: { id },
      data: { is_active: false },
    });
    return { message: 'Solicitud cancelada' };
  }
}
