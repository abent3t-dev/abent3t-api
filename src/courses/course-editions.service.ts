import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateCourseEditionDto } from './dto/create-course-edition.dto';
import { UpdateCourseEditionDto } from './dto/update-course-edition.dto';

@Injectable()
export class CourseEditionsService {
  constructor(private readonly supabase: SupabaseService) {}

  async findByCourse(courseId: string) {
    const { data, error } = await this.supabase.db
      .from('course_editions')
      .select('*')
      .eq('course_id', courseId)
      .order('start_date', { ascending: false });

    if (error) throw error;
    return data;
  }

  async findOne(courseId: string, editionId: string) {
    const { data, error } = await this.supabase.db
      .from('course_editions')
      .select('*')
      .eq('id', editionId)
      .eq('course_id', courseId)
      .single();

    if (error || !data) throw new NotFoundException('Edición no encontrada');
    return data;
  }

  async create(courseId: string, dto: CreateCourseEditionDto) {
    const { data, error } = await this.supabase.db
      .from('course_editions')
      .insert({ ...dto, course_id: courseId })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async update(courseId: string, editionId: string, dto: UpdateCourseEditionDto) {
    const { data, error } = await this.supabase.db
      .from('course_editions')
      .update(dto)
      .eq('id', editionId)
      .eq('course_id', courseId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Edición no encontrada');
    return data;
  }

  async remove(courseId: string, editionId: string) {
    const { error } = await this.supabase.db
      .from('course_editions')
      .update({ is_active: false })
      .eq('id', editionId)
      .eq('course_id', courseId);

    if (error) throw error;
    return { message: 'Edición desactivada' };
  }
}
