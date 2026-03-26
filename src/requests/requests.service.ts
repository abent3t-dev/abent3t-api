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
import { CreateRequestDto } from './dto/create-request.dto';
import { ReviewRequestDto } from './dto/review-request.dto';

const REQUEST_SELECT = `
  *,
  profiles!training_requests_profile_id_fkey(id, full_name, email, position, department_id, departments(id, name)),
  requester:profiles!training_requests_requested_by_fkey(id, full_name, email),
  reviewer:profiles!training_requests_reviewed_by_fkey(id, full_name),
  course_editions(
    id, start_date, end_date, location, instructor,
    courses(id, name, cost, total_hours, institutions(name), modalities(name))
  )
`;

@Injectable()
export class RequestsService {
  private readonly logger = new Logger(RequestsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly enrollmentsService: EnrollmentsService,
  ) {}

  /**
   * Get all requests (for admin_rh)
   */
  async findAll(status?: string) {
    let query = this.supabase.db
      .from('training_requests')
      .select(REQUEST_SELECT)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  /**
   * Get pending requests (for admin_rh dashboard)
   */
  async findPending() {
    return this.findAll('pendiente');
  }

  /**
   * Get requests made by a specific user (jefe_area)
   */
  async findByRequester(requesterId: string) {
    const { data, error } = await this.supabase.db
      .from('training_requests')
      .select(REQUEST_SELECT)
      .eq('requested_by', requesterId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  /**
   * Get requests for profiles in a specific department
   */
  async findByDepartment(departmentId: string) {
    const { data, error } = await this.supabase.db
      .from('training_requests')
      .select(REQUEST_SELECT)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Filter by department (profile's department)
    return data?.filter((r: any) =>
      r.profiles?.department_id === departmentId
    ) || [];
  }

  /**
   * Get a single request by ID
   */
  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('training_requests')
      .select(REQUEST_SELECT)
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException('Solicitud no encontrada');
    }
    return data;
  }

  /**
   * Create a new training request (by jefe_area)
   */
  async create(dto: CreateRequestDto, requestedBy: string, requesterDepartmentId: string | null) {
    // 1. Validate that the profile exists and is active
    const { data: profile } = await this.supabase.db
      .from('profiles')
      .select('id, full_name, department_id, is_active')
      .eq('id', dto.profile_id)
      .single();

    if (!profile) {
      throw new BadRequestException('El colaborador no existe');
    }
    if (!profile.is_active) {
      throw new BadRequestException('El colaborador está desactivado');
    }

    // 2. Validate that jefe_area can only request for their own department
    if (requesterDepartmentId && profile.department_id !== requesterDepartmentId) {
      throw new ForbiddenException(
        'Solo puedes solicitar capacitación para colaboradores de tu área',
      );
    }

    // 3. Validate that the edition exists and is active
    const { data: edition } = await this.supabase.db
      .from('course_editions')
      .select('id, is_active, courses(name)')
      .eq('id', dto.course_edition_id)
      .single();

    if (!edition) {
      throw new BadRequestException('La edición del curso no existe');
    }
    if (!edition.is_active) {
      throw new BadRequestException('La edición del curso no está activa');
    }

    // 4. Check if already enrolled
    const { data: existingEnrollment } = await this.supabase.db
      .from('course_enrollments')
      .select('id')
      .eq('course_edition_id', dto.course_edition_id)
      .eq('profile_id', dto.profile_id)
      .eq('is_active', true)
      .single();

    if (existingEnrollment) {
      throw new ConflictException(
        'El colaborador ya está inscrito en esta edición',
      );
    }

    // 5. Check if there's already a pending request
    const { data: existingRequest } = await this.supabase.db
      .from('training_requests')
      .select('id')
      .eq('course_edition_id', dto.course_edition_id)
      .eq('profile_id', dto.profile_id)
      .eq('status', 'pendiente')
      .eq('is_active', true)
      .single();

    if (existingRequest) {
      throw new ConflictException(
        'Ya existe una solicitud pendiente para este colaborador y curso',
      );
    }

    // 6. Create the request
    const { data, error } = await this.supabase.db
      .from('training_requests')
      .insert({
        course_edition_id: dto.course_edition_id,
        profile_id: dto.profile_id,
        requested_by: requestedBy,
        request_reason: dto.request_reason,
        status: 'pendiente',
      })
      .select(REQUEST_SELECT)
      .single();

    if (error) {
      this.logger.error('Error creating request', error);
      throw error;
    }

    this.logger.log(
      `Request created: ${profile.full_name} for ${(edition.courses as any)?.name}`,
    );

    return data;
  }

  /**
   * Review (approve/reject) a request (by admin_rh)
   */
  async review(id: string, dto: ReviewRequestDto, reviewedBy: string) {
    // 1. Get the request
    const { data: request } = await this.supabase.db
      .from('training_requests')
      .select('id, status, course_edition_id, profile_id')
      .eq('id', id)
      .eq('is_active', true)
      .single();

    if (!request) {
      throw new NotFoundException('Solicitud no encontrada');
    }

    if (request.status !== 'pendiente') {
      throw new BadRequestException(
        `La solicitud ya fue ${request.status}`,
      );
    }

    // 2. If rejecting, just update status
    if (dto.status === 'rechazada') {
      if (!dto.rejection_reason) {
        throw new BadRequestException(
          'Debe proporcionar un motivo de rechazo',
        );
      }

      const { data, error } = await this.supabase.db
        .from('training_requests')
        .update({
          status: 'rechazada',
          rejection_reason: dto.rejection_reason,
          reviewed_by: reviewedBy,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select(REQUEST_SELECT)
        .single();

      if (error) throw error;

      this.logger.log(`Request ${id} rejected: ${dto.rejection_reason}`);
      return data;
    }

    // 3. If approving, create the enrollment
    const enrollment = await this.enrollmentsService.create(
      {
        course_edition_id: request.course_edition_id,
        profile_id: request.profile_id,
      },
      true, // bypass blocking check since admin_rh is approving
    );

    // 4. Update the request with approval info
    const { data, error } = await this.supabase.db
      .from('training_requests')
      .update({
        status: 'aprobada',
        reviewed_by: reviewedBy,
        reviewed_at: new Date().toISOString(),
        enrollment_id: enrollment.id,
      })
      .eq('id', id)
      .select(REQUEST_SELECT)
      .single();

    if (error) throw error;

    this.logger.log(`Request ${id} approved, enrollment ${enrollment.id} created`);
    return data;
  }

  /**
   * Cancel a request (by the requester, only if pending)
   */
  async cancel(id: string, cancelledBy: string) {
    const { data: request } = await this.supabase.db
      .from('training_requests')
      .select('id, status, requested_by')
      .eq('id', id)
      .eq('is_active', true)
      .single();

    if (!request) {
      throw new NotFoundException('Solicitud no encontrada');
    }

    // Only the requester can cancel, and only if pending
    if (request.requested_by !== cancelledBy) {
      throw new ForbiddenException('Solo el solicitante puede cancelar');
    }

    if (request.status !== 'pendiente') {
      throw new BadRequestException(
        `No se puede cancelar una solicitud ${request.status}`,
      );
    }

    const { error } = await this.supabase.db
      .from('training_requests')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;

    return { message: 'Solicitud cancelada' };
  }
}
