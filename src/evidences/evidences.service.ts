import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateEvidenceDto } from './dto/create-evidence.dto';
import { UpdateEvidenceDto } from './dto/update-evidence.dto';
import { VerifyEvidenceDto } from './dto/verify-evidence.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/interfaces/paginated-response.interface';

export interface EvidenceRow {
  id: string;
  enrollment_id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  file_type: string;
  evidence_type: string;
  uploaded_by: string;
  uploaded_at: string;
  verification_status: string;
  verified_by: string | null;
  verified_at: string | null;
  rejection_reason: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const EVIDENCE_SELECT = `
  *,
  course_enrollments!enrollment_id(
    id, profile_id, course_edition_id, status, enrolled_at,
    profiles(id, full_name, email, position, departments(id, name)),
    course_editions(
      id, start_date, end_date, location, instructor,
      courses(
        id, name, total_hours, cost,
        institutions(id, name),
        modalities(id, name)
      )
    )
  ),
  profiles:profiles!uploaded_by(id, full_name, email),
  verified_by_profile:profiles!verified_by(id, full_name, email)
`;

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/msword', // doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

@Injectable()
export class EvidencesService {
  private readonly logger = new Logger(EvidencesService.name);
  private readonly bucketName = 'evidences';

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Lista todas las evidencias activas
   */
  async findAll() {
    const { data, error } = await this.supabase.db
      .from('enrollment_evidences')
      .select(EVIDENCE_SELECT)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  /**
   * Lista todas las evidencias con paginación
   */
  async findAllPaginated(
    pagination: PaginationDto,
  ): Promise<PaginatedResponse<EvidenceRow>> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 10;
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase.db
      .from('enrollment_evidences')
      .select(EVIDENCE_SELECT, { count: 'exact' })
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const total = count ?? 0;
    return {
      data: data ?? [],
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
   * Busca evidencias por inscripción
   */
  async findByEnrollment(enrollmentId: string) {
    const { data, error } = await this.supabase.db
      .from('enrollment_evidences')
      .select(EVIDENCE_SELECT)
      .eq('enrollment_id', enrollmentId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  /**
   * Busca evidencias pendientes de verificación
   */
  async findPending() {
    const { data, error } = await this.supabase.db
      .from('enrollment_evidences')
      .select(EVIDENCE_SELECT)
      .eq('verification_status', 'pending')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data;
  }

  /**
   * Busca evidencias pendientes con paginación
   */
  async findPendingPaginated(
    pagination: PaginationDto,
  ): Promise<PaginatedResponse<EvidenceRow>> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 10;
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase.db
      .from('enrollment_evidences')
      .select(EVIDENCE_SELECT, { count: 'exact' })
      .eq('verification_status', 'pending')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const total = count ?? 0;
    return {
      data: data ?? [],
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
   * Busca evidencias por estado de verificación con paginación
   */
  async findByStatusPaginated(
    status: 'approved' | 'rejected',
    pagination: PaginationDto,
  ): Promise<PaginatedResponse<EvidenceRow>> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 10;
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase.db
      .from('enrollment_evidences')
      .select(EVIDENCE_SELECT, { count: 'exact' })
      .eq('verification_status', status)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const total = count ?? 0;
    return {
      data: data ?? [],
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
   * Obtiene una evidencia por ID
   */
  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('enrollment_evidences')
      .select(EVIDENCE_SELECT)
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Evidencia no encontrada');
    return data;
  }

  /**
   * Sube un archivo y crea el registro de evidencia
   */
  async upload(
    file: Express.Multer.File,
    dto: CreateEvidenceDto,
    uploadedBy: string,
  ) {
    // Validar archivo
    this.validateFile(file);

    // Validar que la inscripción existe y está activa
    await this.validateEnrollment(dto.enrollment_id);

    // Generar path único para el archivo
    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = `${dto.enrollment_id}/${timestamp}_${sanitizedName}`;

    // Subir archivo a Supabase Storage
    const { error: uploadError } = await this.supabase.db.storage
      .from(this.bucketName)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      this.logger.error('Error uploading file:', uploadError);
      throw new BadRequestException('Error al subir el archivo');
    }

    // Crear registro en la base de datos
    const { data, error } = await this.supabase.db
      .from('enrollment_evidences')
      .insert({
        enrollment_id: dto.enrollment_id,
        file_name: file.originalname,
        file_path: filePath,
        file_size: file.size,
        file_type: file.mimetype,
        evidence_type: dto.evidence_type || 'certificate',
        uploaded_by: uploadedBy,
        notes: dto.notes,
      })
      .select(EVIDENCE_SELECT)
      .single();

    if (error) {
      // Intentar eliminar el archivo si falla el registro
      await this.supabase.db.storage.from(this.bucketName).remove([filePath]);
      throw error;
    }

    this.logger.log(`Evidence uploaded: ${data.id} for enrollment ${dto.enrollment_id}`);
    return data;
  }

  /**
   * Actualiza una evidencia
   */
  async update(id: string, dto: UpdateEvidenceDto) {
    const { data, error } = await this.supabase.db
      .from('enrollment_evidences')
      .update(dto)
      .eq('id', id)
      .eq('is_active', true)
      .select(EVIDENCE_SELECT)
      .single();

    if (error || !data) throw new NotFoundException('Evidencia no encontrada');
    return data;
  }

  /**
   * Verifica (aprueba o rechaza) una evidencia
   */
  async verify(id: string, dto: VerifyEvidenceDto, verifiedBy: string) {
    // Validar que existe y está pendiente
    const evidence = await this.findOne(id);
    if (evidence.verification_status !== 'pending') {
      throw new BadRequestException('Esta evidencia ya fue verificada');
    }

    const updateData: Record<string, unknown> = {
      verification_status: dto.verification_status,
      verified_by: verifiedBy,
      verified_at: new Date().toISOString(),
    };

    if (dto.verification_status === 'rejected' && dto.rejection_reason) {
      updateData.rejection_reason = dto.rejection_reason;
    }

    const { data, error } = await this.supabase.db
      .from('enrollment_evidences')
      .update(updateData)
      .eq('id', id)
      .select(EVIDENCE_SELECT)
      .single();

    if (error) throw error;

    this.logger.log(
      `Evidence ${id} ${dto.verification_status} by ${verifiedBy}`,
    );

    // Si se aprobó, verificar si todas las evidencias del enrollment están aprobadas
    // para actualizar el estado del enrollment a 'completo'
    if (dto.verification_status === 'approved') {
      await this.checkEnrollmentCompletion(evidence.enrollment_id);
    }

    return data;
  }

  /**
   * Elimina una evidencia (soft delete)
   */
  async remove(id: string) {
    const evidence = await this.findOne(id);

    const { error } = await this.supabase.db
      .from('enrollment_evidences')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;

    this.logger.log(`Evidence ${id} deactivated`);
    return { message: 'Evidencia eliminada correctamente' };
  }

  /**
   * Obtiene URL firmada para descargar archivo
   */
  async getDownloadUrl(id: string) {
    const evidence = await this.findOne(id);

    const { data, error } = await this.supabase.db.storage
      .from(this.bucketName)
      .createSignedUrl(evidence.file_path, 3600); // 1 hora

    if (error) {
      throw new BadRequestException('Error al generar URL de descarga');
    }

    return { url: data.signedUrl, fileName: evidence.file_name };
  }

  /**
   * Valida el archivo subido
   */
  private validateFile(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Archivo requerido');
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Tipo de archivo no permitido. Formatos válidos: PDF, imágenes (JPG, PNG), Excel, Word',
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('El archivo excede el tamaño máximo de 10MB');
    }
  }

  /**
   * Valida que la inscripción existe y está activa
   */
  private async validateEnrollment(enrollmentId: string) {
    const { data, error } = await this.supabase.db
      .from('course_enrollments')
      .select('id, is_active, status')
      .eq('id', enrollmentId)
      .single();

    if (error || !data) {
      throw new BadRequestException('Inscripción no encontrada');
    }

    if (!data.is_active) {
      throw new BadRequestException('La inscripción no está activa');
    }

    if (data.status === 'cancelado') {
      throw new BadRequestException('No se pueden subir evidencias a una inscripción cancelada');
    }
  }

  /**
   * Verifica si todas las evidencias de un enrollment están aprobadas
   * y actualiza el estado del enrollment si corresponde
   */
  private async checkEnrollmentCompletion(enrollmentId: string) {
    // Contar evidencias pendientes o rechazadas
    const { count } = await this.supabase.db
      .from('enrollment_evidences')
      .select('id', { count: 'exact', head: true })
      .eq('enrollment_id', enrollmentId)
      .eq('is_active', true)
      .neq('verification_status', 'approved');

    // Si todas están aprobadas y hay al menos una, actualizar enrollment
    if (count === 0) {
      const { count: totalCount } = await this.supabase.db
        .from('enrollment_evidences')
        .select('id', { count: 'exact', head: true })
        .eq('enrollment_id', enrollmentId)
        .eq('is_active', true);

      if (totalCount && totalCount > 0) {
        // Verificar estado actual del enrollment
        const { data: enrollment } = await this.supabase.db
          .from('course_enrollments')
          .select('status')
          .eq('id', enrollmentId)
          .single();

        // Solo actualizar si está en pendiente_evidencia
        if (enrollment?.status === 'pendiente_evidencia') {
          await this.supabase.db
            .from('course_enrollments')
            .update({ status: 'completo', completed_at: new Date().toISOString() })
            .eq('id', enrollmentId);

          this.logger.log(
            `Enrollment ${enrollmentId} marked as complete (all evidences approved)`,
          );
        }
      }
    }
  }
}
