import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

@Injectable()
export class DepartmentsService {
  constructor(private readonly supabase: SupabaseService) {}

  async findAll() {
    const { data, error } = await this.supabase.db
      .from('departments')
      .select('*')
      .order('name');

    if (error) throw error;
    return data;
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('departments')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Departamento no encontrado');
    return data;
  }

  async create(dto: CreateDepartmentDto) {
    const { data, error } = await this.supabase.db
      .from('departments')
      .insert(dto)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async update(id: string, dto: UpdateDepartmentDto) {
    const { data, error } = await this.supabase.db
      .from('departments')
      .update(dto)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Departamento no encontrado');
    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabase.db
      .from('departments')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;
    return { message: 'Departamento desactivado' };
  }
}
