import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateCourseTypeDto } from './dto/create-course-type.dto';
import { UpdateCourseTypeDto } from './dto/update-course-type.dto';

@Injectable()
export class CourseTypesService {
  constructor(private readonly supabase: SupabaseService) {}

  async findAll() {
    const { data, error } = await this.supabase.db
      .from('course_types')
      .select('*')
      .order('name');

    if (error) throw error;
    return data;
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('course_types')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Tipo de curso no encontrado');
    return data;
  }

  async create(dto: CreateCourseTypeDto) {
    const { data, error } = await this.supabase.db
      .from('course_types')
      .insert(dto)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async update(id: string, dto: UpdateCourseTypeDto) {
    const { data, error } = await this.supabase.db
      .from('course_types')
      .update(dto)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Tipo de curso no encontrado');
    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabase.db
      .from('course_types')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;
    return { message: 'Tipo de curso desactivado' };
  }
}
