import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreatePersonnelDto } from './dto/create-personnel.dto';
import { UpdatePersonnelDto } from './dto/update-personnel.dto';

// Roles administrables desde el módulo de personal por admin_rh.
// Incluye 'collaborator' (legacy) para mantener compatibilidad de lectura.
const PERSONNEL_ROLES_FILTER = ['colaborador', 'collaborator', 'jefe_area', 'director'];

interface PersonnelFilters {
  department_id?: string;
  is_active?: boolean;
  search?: string;
  role?: string;
}

@Injectable()
export class PersonnelService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * List all personnel (colaboradores y jefes de area, sin admins)
   */
  async findAll(filters?: PersonnelFilters) {
    let query = this.supabase.db
      .from('profiles')
      .select('*, departments(id, name)')
      .in('role', PERSONNEL_ROLES_FILTER)
      .order('full_name');

    if (filters?.department_id) {
      query = query.eq('department_id', filters.department_id);
    }
    if (filters?.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active);
    }
    if (filters?.role && PERSONNEL_ROLES_FILTER.includes(filters.role)) {
      query = query.eq('role', filters.role);
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
    const role = dto.role || 'colaborador';

    // Update the profile with additional data
    const { data: profile, error: profileError } = await this.supabase.db
      .from('profiles')
      .update({
        full_name: dto.full_name,
        position: dto.position || null,
        role,
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
          role,
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

    // Solo se permite cambiar el rol entre los roles administrables desde este módulo
    if (dto.role && !PERSONNEL_ROLES_FILTER.includes(existing.role)) {
      throw new BadRequestException('No se puede modificar el rol de este usuario desde personal');
    }

    const updatePayload: Record<string, unknown> = {
      full_name: dto.full_name,
      position: dto.position,
      department_id: dto.department_id,
    };
    if (dto.role) updatePayload.role = dto.role;

    const { data, error } = await this.supabase.db
      .from('profiles')
      .update(updatePayload)
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
      .select('id, is_active, department_id, role')
      .in('role', PERSONNEL_ROLES_FILTER);

    if (allError) throw allError;

    const total = all?.length || 0;
    const active = all?.filter((p) => p.is_active).length || 0;
    const inactive = total - active;

    const collaborators = all?.filter((p) =>
      ['colaborador', 'collaborator'].includes(p.role) && p.is_active,
    ).length || 0;
    const managers = all?.filter((p) =>
      ['jefe_area', 'director'].includes(p.role) && p.is_active,
    ).length || 0;

    // Count by department
    const byDepartment: Record<string, number> = {};
    all?.forEach((p) => {
      if (p.department_id && p.is_active) {
        byDepartment[p.department_id] = (byDepartment[p.department_id] || 0) + 1;
      }
    });

    return {
      total,
      active,
      inactive,
      collaborators,
      managers,
      by_department: byDepartment,
    };
  }
}
