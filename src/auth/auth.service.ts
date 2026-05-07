import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  upsertUserRole,
  revokeUserRole,
  getModuleForRole,
} from '../common/services/user-roles.helper';

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

  /**
   * Busca un usuario por email (case-insensitive) y devuelve su info básica
   * + roles asignados por módulo. Usado por la UI de alta de usuarios para
   * detectar duplicados antes del submit y darle feedback al admin.
   *
   * No expone password ni datos sensibles.
   */
  async lookupByEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return { exists: false as const };

    const { data: profile } = await this.supabase.db
      .from('profiles')
      .select(`
        id, full_name, email, position, role, is_active,
        departments(id, name)
      `)
      .ilike('email', normalized)
      .maybeSingle();

    if (!profile) return { exists: false as const };

    let roles_by_module: { module: string; role: string }[] = [];
    try {
      const { data } = await this.supabase.db
        .from('user_roles')
        .select('module, role')
        .eq('profile_id', profile.id)
        .eq('is_active', true);
      roles_by_module = data ?? [];
    } catch {
      roles_by_module = [];
    }

    return {
      exists: true as const,
      profile,
      roles_by_module,
    };
  }

  async getProfile(userId: string) {
    const { data, error } = await this.supabase.db
      .from('profiles')
      .select('*, departments(id, name)')
      .eq('id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Perfil no encontrado');

    // Cargar roles por módulo (tabla user_roles). Si la tabla aún no existe,
    // devolvemos solo el rol primario.
    let assignments: { module: string; role: string }[] = [];
    try {
      const { data: rolesData } = await this.supabase.db
        .from('user_roles')
        .select('module, role')
        .eq('profile_id', userId)
        .eq('is_active', true);
      assignments = rolesData ?? [];
    } catch {
      assignments = [];
    }

    const rolesSet = new Set<string>();
    if (data.role) rolesSet.add(data.role);
    for (const a of assignments) rolesSet.add(a.role);

    return {
      ...data,
      roles: Array.from(rolesSet),
      role_assignments: assignments,
    };
  }

  /**
   * Actualiza el rol primario del usuario y mantiene `user_roles` sincronizado:
   *  - Revoca la entrada vieja en user_roles del módulo correspondiente al rol
   *    primario anterior (si lo había)
   *  - Asigna/reactiva la entrada nueva con el rol nuevo
   *
   * Las asignaciones en OTROS módulos quedan intactas.
   */
  async updateRole(userId: string, role: string, performedBy?: string) {
    // 1. Obtener el rol primario actual para saber qué revocar
    const { data: existing } = await this.supabase.db
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single();

    const oldRole = existing?.role;

    // 2. Actualizar rol primario en profiles
    const { data, error } = await this.supabase.db
      .from('profiles')
      .update({ role })
      .eq('id', userId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Perfil no encontrado');

    // 3. Sincronizar user_roles
    if (oldRole && oldRole !== role) {
      await revokeUserRole(this.supabase.db, {
        profileId: userId,
        role: oldRole,
        revokedBy: performedBy ?? null,
      });
    }
    await upsertUserRole(this.supabase.db, {
      profileId: userId,
      role,
      grantedBy: performedBy ?? null,
    });

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

  /**
   * Alta de usuario.
   *
   * Lógica multi-módulo:
   *  - Si el email NO existe en profiles: crea auth.users + profile y asigna
   *    el rol indicado tanto en profiles.role (primario) como en user_roles.
   *  - Si el email YA existe: NO crea nada nuevo. Simplemente agrega el rol
   *    como adicional en user_roles del usuario existente y devuelve el
   *    perfil enriquecido con un flag `existing_user_added_role: true`
   *    para que el frontend pueda mostrar un mensaje claro al super_admin.
   */
  async createUser(dto: CreateUserDto, performedBy?: string) {
    if (!dto.email) {
      throw new BadRequestException('El email es requerido');
    }

    const targetRole = dto.role || 'colaborador';
    const normalizedEmail = dto.email.trim().toLowerCase();

    // 1. ¿Ya existe un usuario con ese email? (case-insensitive)
    const { data: existing } = await this.supabase.db
      .from('profiles')
      .select('id, email, full_name, role, is_active')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    if (existing) {
      if (!existing.is_active) {
        throw new BadRequestException(
          `Ya existe un usuario con este email pero está desactivado. Reactívalo desde la lista en lugar de crear uno nuevo.`,
        );
      }
      // Agregar el rol como adicional en user_roles del usuario existente
      await upsertUserRole(this.supabase.db, {
        profileId: existing.id,
        role: targetRole,
        grantedBy: performedBy ?? null,
      });

      const { data: enriched } = await this.supabase.db
        .from('profiles')
        .select('*, departments(id, name)')
        .eq('id', existing.id)
        .single();

      return {
        ...enriched,
        existing_user_added_role: true,
        added_role: targetRole,
        added_module: getModuleForRole(targetRole),
      };
    }

    // 2. Email nuevo: para crear cuenta nueva sí necesitamos password y nombre
    if (!dto.password || dto.password.length < 6) {
      throw new BadRequestException(
        'La contraseña es requerida y debe tener al menos 6 caracteres',
      );
    }
    if (!dto.full_name?.trim()) {
      throw new BadRequestException('El nombre completo es requerido');
    }

    const { data: authData, error: authError } = await this.supabase.db.auth.admin.createUser({
      email: dto.email,
      password: dto.password,
      email_confirm: true,
      user_metadata: {
        full_name: dto.full_name,
      },
    });

    if (authError) throw new BadRequestException(authError.message);

    const userId = authData.user.id;

    // 3. Actualizar/insertar profile
    const { data: profile, error: profileError } = await this.supabase.db
      .from('profiles')
      .update({
        full_name: dto.full_name,
        position: dto.position || null,
        role: targetRole,
        department_id: dto.department_id || null,
      })
      .eq('id', userId)
      .select('*, departments(id, name)')
      .single();

    let finalProfile = profile;
    if (profileError) {
      // El trigger no creó el perfil aún — insertarlo nosotros
      const { data: newProfile, error: createError } = await this.supabase.db
        .from('profiles')
        .insert({
          id: userId,
          email: dto.email,
          full_name: dto.full_name,
          position: dto.position || null,
          role: targetRole,
          department_id: dto.department_id || null,
        })
        .select('*, departments(id, name)')
        .single();

      if (createError) {
        throw new BadRequestException('Error al crear perfil: ' + createError.message);
      }
      finalProfile = newProfile;
    }

    // 4. Sincronizar user_roles para que el rol primario esté también ahí
    await upsertUserRole(this.supabase.db, {
      profileId: userId,
      role: targetRole,
      grantedBy: performedBy ?? null,
    });

    return finalProfile;
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

  // =====================================================
  // GESTIÓN DE ROLES POR MÓDULO (user_roles)
  // =====================================================

  /** Lista las asignaciones de rol por módulo de un usuario. */
  async listUserRoles(userId: string) {
    const { data, error } = await this.supabase.db
      .from('user_roles')
      .select(`
        id, profile_id, module, role, granted_at, revoked_at, is_active,
        granted_by_profile:granted_by(id, full_name, email)
      `)
      .eq('profile_id', userId)
      .order('module')
      .order('role');

    if (error) throw error;
    return data ?? [];
  }

  /** Asigna un rol nuevo a un usuario en un módulo. Reactiva si ya existía revocado. */
  async assignUserRole(
    userId: string,
    module: string,
    role: string,
    grantedBy: string,
  ) {
    // Verificar usuario
    const { data: target } = await this.supabase.db
      .from('profiles')
      .select('id, is_active')
      .eq('id', userId)
      .single();

    if (!target) throw new NotFoundException('Usuario no encontrado');
    if (!target.is_active) {
      throw new BadRequestException('No se pueden asignar roles a un usuario desactivado');
    }

    // Si ya existe una fila (activa o revocada), reactivarla
    const { data: existing } = await this.supabase.db
      .from('user_roles')
      .select('id, is_active')
      .eq('profile_id', userId)
      .eq('module', module)
      .eq('role', role)
      .maybeSingle();

    if (existing) {
      if (existing.is_active) {
        return existing; // ya está asignado, no hacer nada
      }
      const { data: reactivated, error: reactivateError } = await this.supabase.db
        .from('user_roles')
        .update({
          is_active: true,
          revoked_at: null,
          revoked_by: null,
          granted_by: grantedBy,
          granted_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();
      if (reactivateError) throw reactivateError;
      return reactivated;
    }

    // Crear nueva asignación
    const { data: created, error: createError } = await this.supabase.db
      .from('user_roles')
      .insert({
        profile_id: userId,
        module,
        role,
        granted_by: grantedBy,
      })
      .select()
      .single();

    if (createError) throw createError;
    return created;
  }

  /** Revoca una asignación de rol (soft delete: is_active=false + revoked_at). */
  async revokeUserRole(roleId: string, revokedBy: string) {
    const { data, error } = await this.supabase.db
      .from('user_roles')
      .update({
        is_active: false,
        revoked_at: new Date().toISOString(),
        revoked_by: revokedBy,
      })
      .eq('id', roleId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Asignación de rol no encontrada');
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
