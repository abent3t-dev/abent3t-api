import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
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
  constructor(private readonly supabase: SupabaseService) {}

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
        throw new ConflictException('El participante ya está inscrito en esta edición');
      }
      throw error;
    }
    return data;
  }

  async createBulk(dto: BulkEnrollmentDto) {
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
        throw new ConflictException('Algunos participantes ya están inscritos');
      }
      throw error;
    }
    return data;
  }

  async update(id: string, dto: UpdateEnrollmentDto) {
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
    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabase.db
      .from('course_enrollments')
      .update({ is_active: false, status: 'cancelado' })
      .eq('id', id);

    if (error) throw error;
    return { message: 'Inscripción cancelada' };
  }
}
