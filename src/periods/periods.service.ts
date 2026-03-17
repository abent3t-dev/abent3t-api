import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreatePeriodDto } from './dto/create-period.dto';
import { UpdatePeriodDto } from './dto/update-period.dto';

@Injectable()
export class PeriodsService {
  constructor(private readonly supabase: SupabaseService) {}

  async findAll() {
    const { data, error } = await this.supabase.db
      .from('periods')
      .select('*')
      .order('year', { ascending: false })
      .order('semester', { ascending: true });

    if (error) throw error;
    return data;
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('periods')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Periodo no encontrado');
    return data;
  }

  async create(dto: CreatePeriodDto) {
    const { data, error } = await this.supabase.db
      .from('periods')
      .insert(dto)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async update(id: string, dto: UpdatePeriodDto) {
    const { data, error } = await this.supabase.db
      .from('periods')
      .update(dto)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Periodo no encontrado');
    return data;
  }

  async remove(id: string) {
    const { error } = await this.supabase.db
      .from('periods')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;
    return { message: 'Periodo desactivado' };
  }
}
