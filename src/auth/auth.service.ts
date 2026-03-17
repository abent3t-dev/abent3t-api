import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

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
}
