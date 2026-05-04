import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { SocketService } from '../socket/socket.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { ReviewProposalDto } from './dto/review-proposal.dto';
import { ApproveProposalDto } from './dto/approve-proposal.dto';

const PROPOSAL_SELECT = `
  *,
  proposer:profiles!course_proposals_proposed_by_fkey(id, full_name, email, department_id, departments(id, name)),
  profile:profiles!course_proposals_profile_id_fkey(id, full_name, email, position, department_id, departments(id, name)),
  reviewer:profiles!course_proposals_reviewed_by_fkey(id, full_name),
  courses(id, name),
  course_editions(id, start_date, end_date),
  course_enrollments(id, status),
  attachments:proposal_attachments(id, file_name, file_size, file_type, uploaded_at, uploaded_by, is_active)
`;

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
  private readonly attachmentsBucket = 'proposal-attachments';

  constructor(
    private readonly supabase: SupabaseService,
    private readonly enrollmentsService: EnrollmentsService,
    private readonly socketService: SocketService,
  ) {}

  /**
   * Get all proposals (for admin_rh)
   */
  async findAll(status?: string, page = 1, limit = 10) {
    // First, get the total count
    let countQuery = this.supabase.db
      .from('course_proposals')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);

    if (status) {
      countQuery = countQuery.eq('status', status);
    }

    const { count, error: countError } = await countQuery;
    if (countError) throw countError;

    const total = count || 0;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;

    // Then get the data
    let query = this.supabase.db
      .from('course_proposals')
      .select(PROPOSAL_SELECT)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;

    return {
      data: data || [],
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

  /**
   * Get pending proposals (for admin_rh dashboard)
   */
  async findPending() {
    return this.findAll('pendiente');
  }

  /**
   * Get proposals made by a specific user
   */
  async findByUser(userId: string) {
    const { data, error } = await this.supabase.db
      .from('course_proposals')
      .select(PROPOSAL_SELECT)
      .or(`proposed_by.eq.${userId},profile_id.eq.${userId}`)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  /**
   * Get proposals from all members of a department (for jefe_area)
   * Includes proposals where the proposer OR the beneficiary belongs to the department
   */
  async findByDepartment(departmentId: string) {
    // 1. Get all active profiles in this department
    const { data: profiles, error: profErr } = await this.supabase.db
      .from('profiles')
      .select('id')
      .eq('department_id', departmentId)
      .eq('is_active', true);

    if (profErr) throw profErr;

    const profileIds = (profiles || []).map((p) => p.id);
    if (profileIds.length === 0) return [];

    const idsList = profileIds.join(',');

    // 2. Get proposals where proposer or beneficiary is in this department
    const { data, error } = await this.supabase.db
      .from('course_proposals')
      .select(PROPOSAL_SELECT)
      .or(`proposed_by.in.(${idsList}),profile_id.in.(${idsList})`)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  /**
   * Get a single proposal by ID
   */
  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('course_proposals')
      .select(PROPOSAL_SELECT)
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException('Propuesta no encontrada');
    }
    return data;
  }

  /**
   * Create a new course proposal
   */
  async create(
    dto: CreateProposalDto,
    proposedBy: string,
    proposerRole: string,
    proposerDepartmentId: string | null,
  ) {
    // If no profile_id specified, the proposer is requesting for themselves
    const profileId = dto.profile_id || proposedBy;

    // Validate the target profile
    const { data: profile } = await this.supabase.db
      .from('profiles')
      .select('id, full_name, department_id, is_active')
      .eq('id', profileId)
      .single();

    if (!profile) {
      throw new BadRequestException('El colaborador no existe');
    }
    if (!profile.is_active) {
      throw new BadRequestException('El colaborador está desactivado');
    }

    // jefe_area can only propose for their own department
    if (
      proposerRole === 'jefe_area' &&
      proposerDepartmentId &&
      profile.department_id !== proposerDepartmentId
    ) {
      throw new ForbiddenException(
        'Solo puedes proponer cursos para colaboradores de tu área',
      );
    }

    // colaborador can only propose for themselves
    if (
      ['colaborador', 'collaborator'].includes(proposerRole) &&
      profileId !== proposedBy
    ) {
      throw new ForbiddenException(
        'Solo puedes proponer cursos para ti mismo',
      );
    }

    // Check for duplicate pending proposals with same course name
    const { data: existing } = await this.supabase.db
      .from('course_proposals')
      .select('id')
      .eq('profile_id', profileId)
      .ilike('course_name', dto.course_name)
      .in('status', ['pendiente', 'en_investigacion'])
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (existing) {
      throw new ConflictException(
        'Ya existe una propuesta pendiente para este colaborador con un curso similar',
      );
    }

    // Create the proposal
    const { data, error } = await this.supabase.db
      .from('course_proposals')
      .insert({
        proposed_by: proposedBy,
        profile_id: profileId,
        course_name: dto.course_name,
        institution_name: dto.institution_name || null,
        course_url: dto.course_url ? dto.course_url : null,
        estimated_cost: dto.estimated_cost || 0,
        estimated_hours: dto.estimated_hours || 0,
        modality: dto.modality || null,
        start_date: dto.start_date || null,
        end_date: dto.end_date || null,
        justification: dto.justification || null,
        status: 'pendiente',
      })
      .select(PROPOSAL_SELECT)
      .single();

    if (error) {
      this.logger.error('Error creating proposal', error);
      throw error;
    }

    this.logger.log(
      `Proposal created: "${dto.course_name}" for ${profile.full_name} by user ${proposedBy}`,
    );

    // Emit socket event
    this.socketService.emitProposal(
      'create',
      {
        id: data.id,
        proposerId: proposedBy,
        proposerName: data.proposer?.full_name || '',
        profileId: profileId,
        profileName: profile.full_name,
        courseName: dto.course_name,
        status: 'pendiente',
      },
      { id: proposedBy, name: data.proposer?.full_name || '' },
    );

    return data;
  }

  /**
   * Review a proposal (change status, add notes)
   */
  async review(id: string, dto: ReviewProposalDto, reviewedBy: string) {
    const proposal = await this.findOne(id);

    if (!['pendiente', 'en_investigacion'].includes(proposal.status)) {
      throw new BadRequestException(
        `No se puede revisar una propuesta con estado "${proposal.status}"`,
      );
    }

    // If rejecting, require reason
    if (dto.status === 'rechazada' && !dto.rejection_reason) {
      throw new BadRequestException(
        'Debe proporcionar un motivo de rechazo',
      );
    }

    // If approving via this endpoint, it's an error - use approve() instead
    if (dto.status === 'aprobada') {
      throw new BadRequestException(
        'Para aprobar una propuesta, use el endpoint de aprobación con los datos del curso verificados',
      );
    }

    const updateData: any = {
      status: dto.status,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
    };

    if (dto.review_notes) {
      updateData.review_notes = dto.review_notes;
    }
    if (dto.rejection_reason) {
      updateData.rejection_reason = dto.rejection_reason;
    }

    const { data, error } = await this.supabase.db
      .from('course_proposals')
      .update(updateData)
      .eq('id', id)
      .select(PROPOSAL_SELECT)
      .single();

    if (error) throw error;

    this.logger.log(`Proposal ${id} status changed to: ${dto.status}`);

    // Emit socket event
    const action = dto.status === 'rechazada' ? 'reject' : 'update';
    this.socketService.emitProposal(
      action,
      {
        id: data.id,
        proposerId: proposal.proposed_by,
        proposerName: proposal.proposer?.full_name || '',
        profileId: proposal.profile_id,
        profileName: proposal.profile?.full_name || '',
        courseName: proposal.course_name,
        status: dto.status,
      },
      { id: reviewedBy, name: '' },
    );

    return data;
  }

  /**
   * Approve a proposal by creating the course, edition, and enrollment
   */
  async approve(id: string, dto: ApproveProposalDto, approvedBy: string) {
    const proposal = await this.findOne(id);

    if (!['pendiente', 'en_investigacion'].includes(proposal.status)) {
      throw new BadRequestException(
        `No se puede aprobar una propuesta con estado "${proposal.status}"`,
      );
    }

    // Validate FKs
    await this.validateFK('institutions', dto.institution_id, 'institution_id');
    await this.validateFK('course_types', dto.course_type_id, 'course_type_id');
    await this.validateFK('modalities', dto.modality_id, 'modality_id');

    // 1. Create the course
    const { data: course, error: courseError } = await this.supabase.db
      .from('courses')
      .insert({
        name: dto.course_name,
        institution_id: dto.institution_id,
        course_type_id: dto.course_type_id,
        modality_id: dto.modality_id,
        cost: dto.cost,
        total_hours: dto.total_hours,
        description: dto.description,
      })
      .select()
      .single();

    if (courseError) {
      this.logger.error('Error creating course from proposal', courseError);
      throw courseError;
    }

    this.logger.log(`Course created from proposal: ${course.id} - ${dto.course_name}`);

    // 2. Create the edition
    const { data: edition, error: editionError } = await this.supabase.db
      .from('course_editions')
      .insert({
        course_id: course.id,
        start_date: dto.start_date,
        end_date: dto.end_date,
        location: dto.location,
        instructor: dto.instructor,
      })
      .select()
      .single();

    if (editionError) {
      this.logger.error('Error creating edition from proposal', editionError);
      throw editionError;
    }

    this.logger.log(`Edition created from proposal: ${edition.id}`);

    // 3. Create the enrollment
    const enrollment = await this.enrollmentsService.create(
      {
        course_edition_id: edition.id,
        profile_id: proposal.profile_id,
      },
      true, // bypass blocking check since admin_rh is approving
    );

    this.logger.log(`Enrollment created from proposal: ${enrollment.id}`);

    // 4. Update the proposal
    const { data, error } = await this.supabase.db
      .from('course_proposals')
      .update({
        status: 'aprobada',
        reviewed_by: approvedBy,
        reviewed_at: new Date().toISOString(),
        review_notes: dto.review_notes,
        course_id: course.id,
        course_edition_id: edition.id,
        enrollment_id: enrollment.id,
      })
      .eq('id', id)
      .select(PROPOSAL_SELECT)
      .single();

    if (error) throw error;

    this.logger.log(`Proposal ${id} approved successfully`);

    // Emit socket event
    this.socketService.emitProposal(
      'approve',
      {
        id: data.id,
        proposerId: proposal.proposed_by,
        proposerName: proposal.proposer?.full_name || '',
        profileId: proposal.profile_id,
        profileName: proposal.profile?.full_name || '',
        courseName: dto.course_name,
        status: 'aprobada',
      },
      { id: approvedBy, name: '' },
    );

    // Emit dashboard refresh
    this.socketService.emitDashboardRefresh();

    return {
      proposal: data,
      course,
      edition,
      enrollment,
    };
  }

  /**
   * Cancel a proposal (by the proposer, only if pending)
   */
  async cancel(id: string, cancelledBy: string) {
    const proposal = await this.findOne(id);

    // Only the proposer can cancel
    if (proposal.proposed_by !== cancelledBy) {
      throw new ForbiddenException('Solo el solicitante puede cancelar la propuesta');
    }

    if (!['pendiente', 'en_investigacion'].includes(proposal.status)) {
      throw new BadRequestException(
        `No se puede cancelar una propuesta ${proposal.status}`,
      );
    }

    const { error } = await this.supabase.db
      .from('course_proposals')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;

    return { message: 'Propuesta cancelada' };
  }

  /**
   * Lista archivos adjuntos activos de una propuesta
   */
  async listAttachments(proposalId: string) {
    await this.findOne(proposalId);
    const { data, error } = await this.supabase.db
      .from('proposal_attachments')
      .select('*')
      .eq('proposal_id', proposalId)
      .eq('is_active', true)
      .order('uploaded_at', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Sube un archivo adjunto a una propuesta.
   * Solo el proponente puede subir adjuntos mientras la propuesta esté
   * en estado pendiente o en_investigacion.
   */
  async uploadAttachment(
    proposalId: string,
    file: Express.Multer.File,
    uploadedBy: string,
    userRole: string,
  ) {
    if (!file) {
      throw new BadRequestException('Archivo requerido');
    }
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
    const isAdmin = userRole === 'admin_rh' || userRole === 'super_admin';

    if (!isAdmin && proposal.proposed_by !== uploadedBy) {
      throw new ForbiddenException(
        'Solo el proponente puede subir archivos a esta propuesta',
      );
    }

    if (!isAdmin && !['pendiente', 'en_investigacion'].includes(proposal.status)) {
      throw new BadRequestException(
        `No se pueden agregar archivos a una propuesta ${proposal.status}`,
      );
    }

    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = `${proposalId}/${timestamp}_${sanitizedName}`;

    const { error: uploadError } = await this.supabase.db.storage
      .from(this.attachmentsBucket)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      this.logger.error('Error uploading proposal attachment', uploadError);
      throw new BadRequestException('Error al subir el archivo');
    }

    const { data, error } = await this.supabase.db
      .from('proposal_attachments')
      .insert({
        proposal_id: proposalId,
        file_name: file.originalname,
        file_path: filePath,
        file_size: file.size,
        file_type: file.mimetype,
        uploaded_by: uploadedBy,
      })
      .select('*')
      .single();

    if (error) {
      await this.supabase.db.storage
        .from(this.attachmentsBucket)
        .remove([filePath]);
      throw error;
    }

    this.logger.log(
      `Attachment uploaded: ${data.id} for proposal ${proposalId}`,
    );
    return data;
  }

  /**
   * Genera URL firmada para descargar un adjunto
   */
  async getAttachmentDownloadUrl(attachmentId: string) {
    const { data: attachment, error } = await this.supabase.db
      .from('proposal_attachments')
      .select('*')
      .eq('id', attachmentId)
      .eq('is_active', true)
      .single();

    if (error || !attachment) {
      throw new NotFoundException('Archivo no encontrado');
    }

    const { data, error: signError } = await this.supabase.db.storage
      .from(this.attachmentsBucket)
      .createSignedUrl(attachment.file_path, 3600);

    if (signError || !data) {
      throw new BadRequestException('Error al generar URL de descarga');
    }

    return { url: data.signedUrl, fileName: attachment.file_name };
  }

  /**
   * Elimina (soft delete) un archivo adjunto.
   * Solo el proponente puede borrar mientras la propuesta esté pendiente
   * o en investigación. admin_rh siempre puede.
   */
  async removeAttachment(
    attachmentId: string,
    userId: string,
    userRole: string,
  ) {
    const { data: attachment, error } = await this.supabase.db
      .from('proposal_attachments')
      .select('*, course_proposals(proposed_by, status)')
      .eq('id', attachmentId)
      .single();

    if (error || !attachment) {
      throw new NotFoundException('Archivo no encontrado');
    }

    const isAdmin = userRole === 'admin_rh' || userRole === 'super_admin';
    const proposal = attachment.course_proposals;

    if (!isAdmin && proposal.proposed_by !== userId) {
      throw new ForbiddenException('Solo el proponente puede eliminar el archivo');
    }
    if (
      !isAdmin &&
      !['pendiente', 'en_investigacion'].includes(proposal.status)
    ) {
      throw new BadRequestException(
        `No se pueden eliminar archivos de una propuesta ${proposal.status}`,
      );
    }

    const { error: updateError } = await this.supabase.db
      .from('proposal_attachments')
      .update({ is_active: false })
      .eq('id', attachmentId);

    if (updateError) throw updateError;

    return { message: 'Archivo eliminado' };
  }

  /**
   * Validate that a foreign key exists and is active
   */
  private async validateFK(table: string, id: string, field: string) {
    const { data, error } = await this.supabase.db
      .from(table)
      .select('id, is_active')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new BadRequestException(`${field}: registro no encontrado`);
    }
    if (!data.is_active) {
      throw new BadRequestException(`${field}: el registro está desactivado`);
    }
  }
}
