import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateModalityDto } from './dto/create-modality.dto';
import { UpdateModalityDto } from './dto/update-modality.dto';

@Injectable()
export class ModalitiesService {
  constructor(private readonly supabase: SupabaseService) {}

  async findAll() {
    const { data, error } = await this.supabase.db
      .from('modalities')
      .select('*')
      .order('name');

    if (error) throw error;
    return data;
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('modalities')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Modalidad no encontrada');
    return data;
  }

  async create(dto: CreateModalityDto) {
    const { data, error } = await this.supabase.db
      .from('modalities')
      .insert(dto)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async update(id: string, dto: UpdateModalityDto) {
    const { data, error } = await this.supabase.db
      .from('modalities')
      .update(dto)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Modalidad no encontrada');
    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabase.db
      .from('modalities')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;
    return { message: 'Modalidad desactivada' };
  }
}
