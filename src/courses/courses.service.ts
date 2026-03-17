import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

@Injectable()
export class CoursesService {
  constructor(private readonly supabase: SupabaseService) {}

  async findAll() {
    const { data, error } = await this.supabase.db
      .from('courses')
      .select(
        '*, institutions(id, name), course_types(id, name), modalities(id, name)',
      )
      .order('name');

    if (error) throw error;
    return data;
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('courses')
      .select(
        '*, institutions(id, name), course_types(id, name), modalities(id, name)',
      )
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Curso no encontrado');
    return data;
  }

  async create(dto: CreateCourseDto) {
    const { data, error } = await this.supabase.db
      .from('courses')
      .insert(dto)
      .select(
        '*, institutions(id, name), course_types(id, name), modalities(id, name)',
      )
      .single();

    if (error) throw error;
    return data;
  }

  async update(id: string, dto: UpdateCourseDto) {
    const { data, error } = await this.supabase.db
      .from('courses')
      .update(dto)
      .eq('id', id)
      .select(
        '*, institutions(id, name), course_types(id, name), modalities(id, name)',
      )
      .single();

    if (error || !data) throw new NotFoundException('Curso no encontrado');
    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabase.db
      .from('courses')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;
    return { message: 'Curso desactivado' };
  }
}
