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
import { StorageService } from '../storage/storage.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { SocketService } from '../socket/socket.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { ReviewProposalDto } from './dto/review-proposal.dto';
import { ApproveProposalDto } from './dto/approve-proposal.dto';

const PROPOSAL_INCLUDE = {
  profiles_course_proposals_proposed_byToprofiles: {
    select: {
      id: true,
      full_name: true,
      email: true,
      department_id: true,
      departments: { select: { id: true, name: true } },
    },
  },
  profiles_course_proposals_profile_idToprofiles: {
    select: {
      id: true,
      full_name: true,
      email: true,
      position: true,
      department_id: true,
      departments: { select: { id: true, name: true } },
    },
  },
  profiles_course_proposals_reviewed_byToprofiles: {
    select: { id: true, full_name: true },
  },
  courses: { select: { id: true, name: true } },
  course_editions: {
    select: { id: true, start_date: true, end_date: true },
  },
  course_enrollments: { select: { id: true, status: true } },
  proposal_attachments: {
    select: {
      id: true,
      file_name: true,
      file_size: true,
      file_type: true,
      uploaded_at: true,
      uploaded_by: true,
      is_active: true,
    },
  },
} as const;

function aliasProposal<T extends Record<string, unknown>>(row: T): T {
  if (!row) return row;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = row as any;
  return {
    ...row,
    proposer: r.profiles_course_proposals_proposed_byToprofiles ?? null,
    profile: r.profiles_course_proposals_profile_idToprofiles ?? null,
    reviewer: r.profiles_course_proposals_reviewed_byToprofiles ?? null,
    attachments: r.proposal_attachments ?? [],
  } as T;
}

const ALLOWED_ATTACHMENT_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB

@Injectable()
export class ProposalsService {
  private readonly logger = new Logger(ProposalsService.name);

  /** Fase 3 cerrada: Storage migrado de Supabase a MinIO vía StorageService. */
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly enrollmentsService: EnrollmentsService,
    private readonly socketService: SocketService,
  ) {}

  async findAll(status?: string, page = 1, limit = 10) {
    const where: Prisma.course_proposalsWhereInput = { is_active: true };
    if (status) where.status = status as Prisma.course_proposalsWhereInput['status'];

    const skip = (page - 1) * limit;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.course_proposals.findMany({
        where,
        include: PROPOSAL_INCLUDE,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.course_proposals.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;
    return {
      data: data.map((p) =>
        aliasProposal(p as unknown as Record<string, unknown>),
      ),
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

  /** Propuestas hechas O recibidas por un usuario. */
  async findByUser(userId: string) {
    const data = await this.prisma.course_proposals.findMany({
      where: {
        is_active: true,
        OR: [{ proposed_by: userId }, { profile_id: userId }],
      },
      include: PROPOSAL_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    return data.map((p) =>
      aliasProposal(p as unknown as Record<string, unknown>),
    );
  }

  /** Propuestas donde el proponente O el beneficiario pertenecen al departamento. */
  async findByDepartment(departmentId: string) {
    const profiles = await this.prisma.profiles.findMany({
      where: { department_id: departmentId, is_active: true },
      select: { id: true },
    });
    const profileIds = profiles.map((p) => p.id);
    if (profileIds.length === 0) return [];

    const data = await this.prisma.course_proposals.findMany({
      where: {
        is_active: true,
        OR: [
          { proposed_by: { in: profileIds } },
          { profile_id: { in: profileIds } },
        ],
      },
      include: PROPOSAL_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    return data.map((p) =>
      aliasProposal(p as unknown as Record<string, unknown>),
    );
  }

  async findOne(id: string) {
    const data = await this.prisma.course_proposals.findUnique({
      where: { id },
      include: PROPOSAL_INCLUDE,
    });
    if (!data) throw new NotFoundException('Propuesta no encontrada');
    return aliasProposal(data as unknown as Record<string, unknown>);
  }

  async create(
    dto: CreateProposalDto,
    proposedBy: string,
    proposerRole: string,
    proposerDepartmentId: string | null,
  ) {
    const profileId = dto.profile_id || proposedBy;

    const profile = await this.prisma.profiles.findUnique({
      where: { id: profileId },
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
      proposerRole === 'jefe_area' &&
      proposerDepartmentId &&
      profile.department_id !== proposerDepartmentId
    ) {
      throw new ForbiddenException(
        'Solo puedes proponer cursos para colaboradores de tu área',
      );
    }

    if (
      ['colaborador', 'collaborator'].includes(proposerRole) &&
      profileId !== proposedBy
    ) {
      throw new ForbiddenException(
        'Solo puedes proponer cursos para ti mismo',
      );
    }

    const existing = await this.prisma.course_proposals.findFirst({
      where: {
        profile_id: profileId,
        course_name: { equals: dto.course_name, mode: 'insensitive' },
        status: { in: ['pendiente', 'en_investigacion'] },
        is_active: true,
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'Ya existe una propuesta pendiente para este colaborador con un curso similar',
      );
    }

    const created = await this.prisma.course_proposals.create({
      data: {
        proposed_by: proposedBy,
        profile_id: profileId,
        course_name: dto.course_name,
        institution_name: dto.institution_name || null,
        course_url: dto.course_url ? dto.course_url : null,
        estimated_cost: dto.estimated_cost || 0,
        estimated_hours: dto.estimated_hours || 0,
        modality: dto.modality || null,
        start_date: dto.start_date ? new Date(dto.start_date) : null,
        end_date: dto.end_date ? new Date(dto.end_date) : null,
        justification: dto.justification || null,
        status: 'pendiente',
      },
      include: PROPOSAL_INCLUDE,
    });
    const data = aliasProposal(created as unknown as Record<string, unknown>);

    this.logger.log(
      `Proposal created: "${dto.course_name}" for ${profile.full_name} by user ${proposedBy}`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aliased: any = data;
    this.socketService.emitProposal(
      'create',
      {
        id: aliased.id,
        proposerId: proposedBy,
        proposerName: aliased.proposer?.full_name || '',
        profileId: profileId,
        profileName: profile.full_name ?? '',
        courseName: dto.course_name,
        status: 'pendiente',
      },
      { id: proposedBy, name: aliased.proposer?.full_name || '' },
    );

    return data;
  }

  async review(id: string, dto: ReviewProposalDto, reviewedBy: string) {
    const proposal = await this.findOne(id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = proposal;
    if (!['pendiente', 'en_investigacion'].includes(p.status)) {
      throw new BadRequestException(
        `No se puede revisar una propuesta con estado "${p.status}"`,
      );
    }

    if (dto.status === 'rechazada' && !dto.rejection_reason) {
      throw new BadRequestException(
        'Debe proporcionar un motivo de rechazo',
      );
    }
    if (dto.status === 'aprobada') {
      throw new BadRequestException(
        'Para aprobar una propuesta, use el endpoint de aprobación con los datos del curso verificados',
      );
    }

    const updateData: Record<string, unknown> = {
      status: dto.status,
      reviewed_by: reviewedBy,
      reviewed_at: new Date(),
    };
    if (dto.review_notes) updateData.review_notes = dto.review_notes;
    if (dto.rejection_reason)
      updateData.rejection_reason = dto.rejection_reason;

    const updated = await this.prisma.course_proposals.update({
      where: { id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: updateData as any,
      include: PROPOSAL_INCLUDE,
    });
    const data = aliasProposal(updated as unknown as Record<string, unknown>);

    this.logger.log(`Proposal ${id} status changed to: ${dto.status}`);

    const action = dto.status === 'rechazada' ? 'reject' : 'update';
    this.socketService.emitProposal(
      action,
      {
        id: p.id,
        proposerId: p.proposed_by,
        proposerName: p.proposer?.full_name || '',
        profileId: p.profile_id,
        profileName: p.profile?.full_name || '',
        courseName: p.course_name,
        status: dto.status,
      },
      { id: reviewedBy, name: '' },
    );

    return data;
  }

  async approve(id: string, dto: ApproveProposalDto, approvedBy: string) {
    const proposal = await this.findOne(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = proposal;

    if (!['pendiente', 'en_investigacion'].includes(p.status)) {
      throw new BadRequestException(
        `No se puede aprobar una propuesta con estado "${p.status}"`,
      );
    }

    await this.validateFK(this.prisma.institutions, dto.institution_id, 'institution_id');
    await this.validateFK(this.prisma.course_types, dto.course_type_id, 'course_type_id');
    await this.validateFK(this.prisma.modalities, dto.modality_id, 'modality_id');

    const course = await this.prisma.courses.create({
      data: {
        name: dto.course_name,
        institution_id: dto.institution_id,
        course_type_id: dto.course_type_id,
        modality_id: dto.modality_id,
        cost: dto.cost,
        total_hours: dto.total_hours,
        description: dto.description,
      },
    });
    this.logger.log(
      `Course created from proposal: ${course.id} - ${dto.course_name}`,
    );

    const edition = await this.prisma.course_editions.create({
      data: {
        course_id: course.id,
        start_date: new Date(dto.start_date),
        end_date: dto.end_date ? new Date(dto.end_date) : null,
        location: dto.location,
        instructor: dto.instructor,
      },
    });
    this.logger.log(`Edition created from proposal: ${edition.id}`);

    const enrollment = await this.enrollmentsService.create(
      { course_edition_id: edition.id, profile_id: p.profile_id },
      true, // bypass blocking check (admin_rh approving)
    );
    this.logger.log(`Enrollment created from proposal: ${enrollment.id}`);

    const updated = await this.prisma.course_proposals.update({
      where: { id },
      data: {
        status: 'aprobada',
        reviewed_by: approvedBy,
        reviewed_at: new Date(),
        review_notes: dto.review_notes,
        course_id: course.id,
        course_edition_id: edition.id,
        enrollment_id: enrollment.id,
      },
      include: PROPOSAL_INCLUDE,
    });
    const data = aliasProposal(updated as unknown as Record<string, unknown>);

    this.logger.log(`Proposal ${id} approved successfully`);

    this.socketService.emitProposal(
      'approve',
      {
        id: p.id,
        proposerId: p.proposed_by,
        proposerName: p.proposer?.full_name || '',
        profileId: p.profile_id,
        profileName: p.profile?.full_name || '',
        courseName: dto.course_name,
        status: 'aprobada',
      },
      { id: approvedBy, name: '' },
    );
    this.socketService.emitDashboardRefresh();

    return { proposal: data, course, edition, enrollment };
  }

  async cancel(id: string, cancelledBy: string) {
    const proposal = await this.findOne(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = proposal;

    if (p.proposed_by !== cancelledBy) {
      throw new ForbiddenException(
        'Solo el solicitante puede cancelar la propuesta',
      );
    }
    if (!['pendiente', 'en_investigacion'].includes(p.status)) {
      throw new BadRequestException(
        `No se puede cancelar una propuesta ${p.status}`,
      );
    }

    await this.prisma.course_proposals.update({
      where: { id },
      data: { is_active: false },
    });
    return { message: 'Propuesta cancelada' };
  }

  // ==========================================================================
  // Attachments (Supabase Storage TEMP — Fase 3 → MinIO)
  // ==========================================================================

  async listAttachments(proposalId: string) {
    await this.findOne(proposalId);
    return this.prisma.proposal_attachments.findMany({
      where: { proposal_id: proposalId, is_active: true },
      orderBy: { uploaded_at: 'asc' },
    });
  }

  async uploadAttachment(
    proposalId: string,
    file: Express.Multer.File,
    uploadedBy: string,
    userRole: string,
  ) {
    if (!file) throw new BadRequestException('Archivo requerido');
    if (!ALLOWED_ATTACHMENT_MIME.includes(file.mimetype)) {
      throw new BadRequestException(
        'Tipo de archivo no permitido. Formatos válidos: PDF, imágenes (JPG, PNG), Excel, Word',
      );
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      throw new BadRequestException(
        'El archivo excede el tamaño máximo de 10MB',
      );
    }

    const proposal = await this.findOne(proposalId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = proposal;
    const isAdmin = userRole === 'admin_rh' || userRole === 'super_admin';

    if (!isAdmin && p.proposed_by !== uploadedBy) {
      throw new ForbiddenException(
        'Solo el proponente puede subir archivos a esta propuesta',
      );
    }
    if (
      !isAdmin &&
      !['pendiente', 'en_investigacion'].includes(p.status)
    ) {
      throw new BadRequestException(
        `No se pueden agregar archivos a una propuesta ${p.status}`,
      );
    }

    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = `${proposalId}/${timestamp}_${sanitizedName}`;

    await this.storage.upload(
      this.storage.bucketProposals,
      filePath,
      file.buffer,
      file.mimetype,
    );

    try {
      const data = await this.prisma.proposal_attachments.create({
        data: {
          proposal_id: proposalId,
          file_name: file.originalname,
          file_path: filePath,
          file_size: file.size,
          file_type: file.mimetype,
          uploaded_by: uploadedBy,
        },
      });
      this.logger.log(
        `Attachment uploaded: ${data.id} for proposal ${proposalId}`,
      );
      return data;
    } catch (err) {
      // Rollback del archivo si el insert falla.
      await this.storage.remove(this.storage.bucketProposals, filePath);
      throw err;
    }
  }

  async getAttachmentDownloadUrl(attachmentId: string) {
    const attachment = await this.prisma.proposal_attachments.findFirst({
      where: { id: attachmentId, is_active: true },
    });
    if (!attachment) throw new NotFoundException('Archivo no encontrado');

    const url = await this.storage.getSignedUrl(
      this.storage.bucketProposals,
      attachment.file_path,
      3600,
    );
    return { url, fileName: attachment.file_name };
  }

  async removeAttachment(
    attachmentId: string,
    userId: string,
    userRole: string,
  ) {
    const attachment = await this.prisma.proposal_attachments.findUnique({
      where: { id: attachmentId },
      include: {
        course_proposals: {
          select: { proposed_by: true, status: true },
        },
      },
    });
    if (!attachment) throw new NotFoundException('Archivo no encontrado');

    const isAdmin = userRole === 'admin_rh' || userRole === 'super_admin';
    const proposal = attachment.course_proposals;

    if (!isAdmin && proposal.proposed_by !== userId) {
      throw new ForbiddenException(
        'Solo el proponente puede eliminar el archivo',
      );
    }
    if (
      !isAdmin &&
      !['pendiente', 'en_investigacion'].includes(proposal.status ?? '')
    ) {
      throw new BadRequestException(
        `No se pueden eliminar archivos de una propuesta ${proposal.status}`,
      );
    }

    await this.prisma.proposal_attachments.update({
      where: { id: attachmentId },
      data: { is_active: false },
    });
    return { message: 'Archivo eliminado' };
  }

  /** Valida que un FK exista y esté activo. */
  private async validateFK(
    delegate: { findUnique: (args: unknown) => Promise<unknown> },
    id: string,
    field: string,
  ) {
    const row = (await delegate.findUnique({
      where: { id },
      select: { id: true, is_active: true },
    } as unknown)) as { id: string; is_active?: boolean } | null;

    if (!row) {
      throw new BadRequestException(`${field}: registro no encontrado`);
    }
    if (row.is_active === false) {
      throw new BadRequestException(`${field}: el registro está desactivado`);
    }
  }
}
