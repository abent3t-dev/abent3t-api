import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateEvidenceDto } from './dto/create-evidence.dto';
import { UpdateEvidenceDto } from './dto/update-evidence.dto';
import { VerifyEvidenceDto } from './dto/verify-evidence.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/interfaces/paginated-response.interface';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { isAdmin, isManager } from '../common/utils/roles.util';

const EVIDENCE_INCLUDE = {
  course_enrollments: {
    select: {
      id: true,
      profile_id: true,
      course_edition_id: true,
      status: true,
      enrolled_at: true,
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
          start_date: true,
          end_date: true,
          location: true,
          instructor: true,
          courses: {
            select: {
              id: true,
              name: true,
              total_hours: true,
              cost: true,
              institutions: { select: { id: true, name: true } },
              modalities: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  },
  profiles_enrollment_evidences_uploaded_byToprofiles: {
    select: { id: true, full_name: true, email: true },
  },
  profiles_enrollment_evidences_verified_byToprofiles: {
    select: { id: true, full_name: true, email: true },
  },
} as const;

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

@Injectable()
export class EvidencesService {
  private readonly logger = new Logger(EvidencesService.name);

  /**
   * Fase 3 cerrada: Storage migrado de Supabase a MinIO vía `StorageService`.
   * El bucket se obtiene de `storage.bucketEvidences` (default 'evidences',
   * configurable con `MINIO_BUCKET_EVIDENCES`).
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async findAll() {
    return this.prisma.enrollment_evidences.findMany({
      where: { is_active: true },
      include: EVIDENCE_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
  }

  async findAllPaginated(
    pagination: PaginationDto,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<PaginatedResponse<any>> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 10;
    const skip = (page - 1) * limit;

    const where = { is_active: true };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.enrollment_evidences.findMany({
        where,
        include: EVIDENCE_INCLUDE,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.enrollment_evidences.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  async findByEnrollment(enrollmentId: string, user: AuthUser) {
    await this.assertCanAccessEnrollment(enrollmentId, user);
    return this.prisma.enrollment_evidences.findMany({
      where: { enrollment_id: enrollmentId, is_active: true },
      include: EVIDENCE_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Acceso a la inscripción:
   *   admin/super_admin → siempre.
   *   dueño (profile_id) → su propia.
   *   manager (jefe_area/director) → si la inscripción es de un colaborador
   *     de su mismo departamento.
   */
  private async assertCanAccessEnrollment(
    enrollmentId: string,
    user: AuthUser,
  ): Promise<void> {
    if (isAdmin(user)) return;

    const data = await this.prisma.course_enrollments.findUnique({
      where: { id: enrollmentId },
      select: {
        profile_id: true,
        profiles: { select: { department_id: true } },
      },
    });
    if (!data) throw new NotFoundException('Inscripción no encontrada');

    if (data.profile_id === user.id) return;

    if (isManager(user)) {
      const ownerDept = data.profiles?.department_id;
      if (
        ownerDept &&
        user.department_id &&
        ownerDept === user.department_id
      ) {
        return;
      }
    }

    throw new ForbiddenException(
      'No tienes permiso para acceder a esta inscripción',
    );
  }

  /**
   * Acceso a la evidencia:
   *   admin → siempre. dueño_upload → siempre. dueño_enrollment → siempre.
   *   manager → si el dueño_enrollment es de su departamento.
   */
  private async assertCanAccessEvidence(
    evidenceId: string,
    user: AuthUser,
  ): Promise<void> {
    if (isAdmin(user)) return;

    const data = await this.prisma.enrollment_evidences.findUnique({
      where: { id: evidenceId },
      select: {
        uploaded_by: true,
        course_enrollments: {
          select: {
            profile_id: true,
            profiles: { select: { department_id: true } },
          },
        },
      },
    });
    if (!data) throw new NotFoundException('Evidencia no encontrada');

    if (data.uploaded_by === user.id) return;

    const enrollment = data.course_enrollments;
    if (enrollment?.profile_id === user.id) return;

    if (isManager(user)) {
      const ownerDept = enrollment?.profiles?.department_id;
      if (
        ownerDept &&
        user.department_id &&
        ownerDept === user.department_id
      ) {
        return;
      }
    }

    throw new ForbiddenException(
      'No tienes permiso para acceder a esta evidencia',
    );
  }

  async findPending() {
    return this.prisma.enrollment_evidences.findMany({
      where: { verification_status: 'pending', is_active: true },
      include: EVIDENCE_INCLUDE,
      orderBy: { created_at: 'asc' },
    });
  }

  async findPendingPaginated(
    pagination: PaginationDto,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<PaginatedResponse<any>> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 10;
    const skip = (page - 1) * limit;

    const where = {
      verification_status: 'pending' as const,
      is_active: true,
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.enrollment_evidences.findMany({
        where,
        include: EVIDENCE_INCLUDE,
        orderBy: { created_at: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.enrollment_evidences.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  async findByStatusPaginated(
    status: 'approved' | 'rejected',
    pagination: PaginationDto,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<PaginatedResponse<any>> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 10;
    const skip = (page - 1) * limit;

    const where = { verification_status: status, is_active: true };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.enrollment_evidences.findMany({
        where,
        include: EVIDENCE_INCLUDE,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.enrollment_evidences.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  /**
   * Obtiene una evidencia por ID. Si `user` viene, valida ownership.
   */
  async findOne(id: string, user?: AuthUser) {
    if (user) {
      await this.assertCanAccessEvidence(id, user);
    }

    const data = await this.prisma.enrollment_evidences.findUnique({
      where: { id },
      include: EVIDENCE_INCLUDE,
    });
    if (!data) throw new NotFoundException('Evidencia no encontrada');
    return data;
  }

  /**
   * Sube un archivo y crea el registro. Storage es Supabase TEMP — Fase 3
   * lo reemplaza por MinIO + URLs firmadas. Las queries DB ya son Prisma.
   */
  async upload(
    file: Express.Multer.File,
    dto: CreateEvidenceDto,
    user: AuthUser,
  ) {
    this.validateFile(file);
    await this.assertCanAccessEnrollment(dto.enrollment_id, user);
    await this.validateEnrollment(dto.enrollment_id);

    const uploadedBy = user.id;

    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = `${dto.enrollment_id}/${timestamp}_${sanitizedName}`;

    // Subida a MinIO (Fase 3). `upload` lanza si falla; el DB insert va
    // después para que el rollback sea limpio en caso de error.
    await this.storage.upload(
      this.storage.bucketEvidences,
      filePath,
      file.buffer,
      file.mimetype,
    );

    try {
      const data = await this.prisma.enrollment_evidences.create({
        data: {
          enrollment_id: dto.enrollment_id,
          file_name: file.originalname,
          file_path: filePath,
          file_size: file.size,
          file_type: file.mimetype,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          evidence_type: (dto.evidence_type || 'certificate') as any,
          uploaded_by: uploadedBy,
          notes: dto.notes,
        },
        include: EVIDENCE_INCLUDE,
      });
      this.logger.log(
        `Evidence uploaded: ${data.id} for enrollment ${dto.enrollment_id}`,
      );
      return data;
    } catch (err) {
      // Rollback: el insert falló pero el archivo ya está en MinIO. Lo
      // borramos para no dejar basura. `storage.remove` es best-effort.
      await this.storage.remove(this.storage.bucketEvidences, filePath);
      throw err;
    }
  }

  async update(id: string, dto: UpdateEvidenceDto) {
    try {
      return await this.prisma.enrollment_evidences.update({
        where: { id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: dto as any,
        include: EVIDENCE_INCLUDE,
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2025') {
        throw new NotFoundException('Evidencia no encontrada');
      }
      throw err;
    }
  }

  async verify(id: string, dto: VerifyEvidenceDto, verifiedBy: string) {
    const evidence = await this.findOne(id);
    if (evidence.verification_status !== 'pending') {
      throw new BadRequestException('Esta evidencia ya fue verificada');
    }

    const updateData: Record<string, unknown> = {
      verification_status: dto.verification_status,
      verified_by: verifiedBy,
      verified_at: new Date(),
    };

    if (dto.verification_status === 'rejected' && dto.rejection_reason) {
      updateData.rejection_reason = dto.rejection_reason;
    }

    const data = await this.prisma.enrollment_evidences.update({
      where: { id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: updateData as any,
      include: EVIDENCE_INCLUDE,
    });

    this.logger.log(
      `Evidence ${id} ${dto.verification_status} by ${verifiedBy}`,
    );

    if (dto.verification_status === 'approved') {
      await this.checkEnrollmentCompletion(evidence.enrollment_id);
    }

    return data;
  }

  async remove(id: string) {
    await this.findOne(id); // valida existencia
    await this.prisma.enrollment_evidences.update({
      where: { id },
      data: { is_active: false },
    });
    this.logger.log(`Evidence ${id} deactivated`);
    return { message: 'Evidencia eliminada correctamente' };
  }

  /**
   * URL firmada para descarga. TEMP: Supabase Storage (Fase 3 → MinIO).
   * El ownership ya se valida vía `findOne(id, user)`.
   */
  async getDownloadUrl(id: string, user: AuthUser) {
    const evidence = await this.findOne(id, user);
    const url = await this.storage.getSignedUrl(
      this.storage.bucketEvidences,
      evidence.file_path,
      3600,
    );
    return { url, fileName: evidence.file_name };
  }

  private validateFile(file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Archivo requerido');
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Tipo de archivo no permitido. Formatos válidos: PDF, imágenes (JPG, PNG), Excel, Word',
      );
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        'El archivo excede el tamaño máximo de 10MB',
      );
    }
  }

  private async validateEnrollment(enrollmentId: string) {
    const data = await this.prisma.course_enrollments.findUnique({
      where: { id: enrollmentId },
      select: { id: true, is_active: true, status: true },
    });
    if (!data) throw new BadRequestException('Inscripción no encontrada');
    if (!data.is_active)
      throw new BadRequestException('La inscripción no está activa');
    if (data.status === 'cancelado') {
      throw new BadRequestException(
        'No se pueden subir evidencias a una inscripción cancelada',
      );
    }
  }

  /**
   * Si todas las evidencias del enrollment están aprobadas, marca el
   * enrollment como completo. Solo si está en pendiente_evidencia.
   */
  private async checkEnrollmentCompletion(enrollmentId: string) {
    const pending = await this.prisma.enrollment_evidences.count({
      where: {
        enrollment_id: enrollmentId,
        is_active: true,
        verification_status: { not: 'approved' },
      },
    });

    if (pending === 0) {
      const total = await this.prisma.enrollment_evidences.count({
        where: { enrollment_id: enrollmentId, is_active: true },
      });

      if (total > 0) {
        const enrollment = await this.prisma.course_enrollments.findUnique({
          where: { id: enrollmentId },
          select: { status: true },
        });
        if (enrollment?.status === 'pendiente_evidencia') {
          await this.prisma.course_enrollments.update({
            where: { id: enrollmentId },
            data: { status: 'completo', completed_at: new Date() },
          });
          this.logger.log(
            `Enrollment ${enrollmentId} marked as complete (all evidences approved)`,
          );
        }
      }
    }
  }
}
