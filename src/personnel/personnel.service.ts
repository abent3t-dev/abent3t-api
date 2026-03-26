import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreatePersonnelDto } from './dto/create-personnel.dto';
import { UpdatePersonnelDto } from './dto/update-personnel.dto';

interface PersonnelFilters {
  department_id?: string;
  is_active?: boolean;
  search?: string;
}

@Injectable()
export class PersonnelService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * List all personnel (colaboradores only, not admins)
   */
  async findAll(filters?: PersonnelFilters) {
    let query = this.supabase.db
      .from('profiles')
      .select('*, departments(id, name)')
      .in('role', ['colaborador', 'collaborator'])
      .order('full_name');

    if (filters?.department_id) {
      query = query.eq('department_id', filters.department_id);
    }
    if (filters?.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active);
    }
    if (filters?.search) {
      query = query.or(`full_name.ilike.%${filters.search}%,email.ilike.%${filters.search}%,position.ilike.%${filters.search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  /**
   * Get a single personnel record
   */
  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('profiles')
      .select('*, departments(id, name)')
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Colaborador no encontrado');
    return data;
  }

  /**
   * Create a new collaborator
   */
  async create(dto: CreatePersonnelDto) {
    // Create user in Supabase Auth
    const { data: authData, error: authError } = await this.supabase.db.auth.admin.createUser({
      email: dto.email,
      password: dto.password,
      email_confirm: true,
      user_metadata: {
        full_name: dto.full_name,
      },
    });

    if (authError) {
      if (authError.message.includes('already been registered')) {
        throw new BadRequestException('El correo electrónico ya está registrado');
      }
      throw new BadRequestException(authError.message);
    }

    const userId = authData.user.id;

    // Update the profile with additional data
    const { data: profile, error: profileError } = await this.supabase.db
      .from('profiles')
      .update({
        full_name: dto.full_name,
        position: dto.position || null,
        role: 'colaborador',
        department_id: dto.department_id || null,
      })
      .eq('id', userId)
      .select('*, departments(id, name)')
      .single();

    if (profileError) {
      // Profile might not exist yet due to trigger timing
      const { data: newProfile, error: createError } = await this.supabase.db
        .from('profiles')
        .insert({
          id: userId,
          email: dto.email,
          full_name: dto.full_name,
          position: dto.position || null,
          role: 'colaborador',
          department_id: dto.department_id || null,
        })
        .select('*, departments(id, name)')
        .single();

      if (createError) {
        throw new BadRequestException('Error al crear perfil: ' + createError.message);
      }

      return newProfile;
    }

    return profile;
  }

  /**
   * Update collaborator data (name, position, department)
   */
  async update(id: string, dto: UpdatePersonnelDto) {
    // Verify the profile exists
    const existing = await this.findOne(id);
    if (!existing) throw new NotFoundException('Colaborador no encontrado');

    const { data, error } = await this.supabase.db
      .from('profiles')
      .update({
        full_name: dto.full_name,
        position: dto.position,
        department_id: dto.department_id,
      })
      .eq('id', id)
      .select('*, departments(id, name)')
      .single();

    if (error) throw new BadRequestException('Error al actualizar: ' + error.message);
    return data;
  }

  /**
   * Soft delete - deactivate collaborator
   */
  async deactivate(id: string) {
    const { data, error } = await this.supabase.db
      .from('profiles')
      .update({ is_active: false, deactivated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, departments(id, name)')
      .single();

    if (error || !data) throw new NotFoundException('Colaborador no encontrado');
    return data;
  }

  /**
   * Reactivate collaborator
   */
  async reactivate(id: string) {
    const { data, error } = await this.supabase.db
      .from('profiles')
      .update({ is_active: true, deactivated_at: null })
      .eq('id', id)
      .select('*, departments(id, name)')
      .single();

    if (error || !data) throw new NotFoundException('Colaborador no encontrado');
    return data;
  }

  /**
   * Get statistics for personnel
   */
  async getStats() {
    const { data: all, error: allError } = await this.supabase.db
      .from('profiles')
      .select('id, is_active, department_id')
      .in('role', ['colaborador', 'collaborator']);

    if (allError) throw allError;

    const total = all?.length || 0;
    const active = all?.filter(p => p.is_active).length || 0;
    const inactive = total - active;

    // Count by department
    const byDepartment: Record<string, number> = {};
    all?.forEach(p => {
      if (p.department_id && p.is_active) {
        byDepartment[p.department_id] = (byDepartment[p.department_id] || 0) + 1;
      }
    });

    return {
      total,
      active,
      inactive,
      by_department: byDepartment,
    };
  }
}
