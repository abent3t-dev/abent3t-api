import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

interface CreateUserDto {
  email: string;
  password: string;
  full_name: string;
  position?: string;
  role?: string;
  department_id?: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly supabase: SupabaseService) {}

  async getProfile(userId: string) {
    const { data, error } = await this.supabase.db
      .from('profiles')
      .select('*, departments(id, name)')
      .eq('id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Perfil no encontrado');
    return data;
  }

  async updateRole(userId: string, role: string) {
    const { data, error } = await this.supabase.db
      .from('profiles')
      .update({ role })
      .eq('id', userId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Perfil no encontrado');
    return data;
  }

  async assignDepartment(userId: string, departmentId: string) {
    const { data, error } = await this.supabase.db
      .from('profiles')
      .update({ department_id: departmentId })
      .eq('id', userId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Perfil no encontrado');
    return data;
  }

  async listUsers(filters?: { role?: string; department_id?: string; is_active?: boolean }) {
    let query = this.supabase.db
      .from('profiles')
      .select('*, departments(id, name)')
      .order('full_name');

    if (filters?.role) query = query.eq('role', filters.role);
    if (filters?.department_id) query = query.eq('department_id', filters.department_id);
    if (filters?.is_active !== undefined) query = query.eq('is_active', filters.is_active);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async deactivateUser(userId: string) {
    const { data, error } = await this.supabase.db
      .from('profiles')
      .update({ is_active: false, deactivated_at: new Date().toISOString() })
      .eq('id', userId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Perfil no encontrado');
    return data;
  }

  async createUser(dto: CreateUserDto) {
    // Validar datos requeridos
    if (!dto.email || !dto.password || !dto.full_name) {
      throw new BadRequestException('Email, contraseña y nombre son requeridos');
    }

    // Crear usuario en Supabase Auth
    const { data: authData, error: authError } = await this.supabase.db.auth.admin.createUser({
      email: dto.email,
      password: dto.password,
      email_confirm: true,
      user_metadata: {
        full_name: dto.full_name,
      },
    });

    if (authError) {
      throw new BadRequestException(authError.message);
    }

    const userId = authData.user.id;

    // Actualizar el perfil con datos adicionales
    const { data: profile, error: profileError } = await this.supabase.db
      .from('profiles')
      .update({
        full_name: dto.full_name,
        position: dto.position || null,
        role: dto.role || 'colaborador',
        department_id: dto.department_id || null,
      })
      .eq('id', userId)
      .select('*, departments(id, name)')
      .single();

    if (profileError) {
      console.error('Error updating profile:', profileError);
      // El usuario fue creado pero el perfil puede no existir aún
      // Intentar crear el perfil directamente
      const { data: newProfile, error: createError } = await this.supabase.db
        .from('profiles')
        .insert({
          id: userId,
          email: dto.email,
          full_name: dto.full_name,
          position: dto.position || null,
          role: dto.role || 'colaborador',
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

  async reactivateUser(userId: string) {
    const { data, error } = await this.supabase.db
      .from('profiles')
      .update({ is_active: true, deactivated_at: null })
      .eq('id', userId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Perfil no encontrado');
    return data;
  }

  /**
   * Get team members for a department (jefe_area use case)
   */
  async getMyTeam(departmentId: string, excludeUserId?: string) {
    let query = this.supabase.db
      .from('profiles')
      .select('*, departments(id, name)')
      .eq('department_id', departmentId)
      .eq('is_active', true)
      .order('full_name');

    if (excludeUserId) {
      query = query.neq('id', excludeUserId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }
}
