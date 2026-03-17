import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateInstitutionDto } from './dto/create-institution.dto';
import { UpdateInstitutionDto } from './dto/update-institution.dto';

@Injectable()
export class InstitutionsService {
  constructor(private readonly supabase: SupabaseService) {}

  async findAll() {
    const { data, error } = await this.supabase.db
      .from('institutions')
      .select('*')
      .order('name');

    if (error) throw error;
    return data;
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('institutions')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Institución no encontrada');
    return data;
  }

  async create(dto: CreateInstitutionDto) {
    const { data, error } = await this.supabase.db
      .from('institutions')
      .insert(dto)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async update(id: string, dto: UpdateInstitutionDto) {
    const { data, error } = await this.supabase.db
      .from('institutions')
      .update(dto)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Institución no encontrada');
    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabase.db
      .from('institutions')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;
    return { message: 'Institución desactivada' };
  }
}
