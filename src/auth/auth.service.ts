import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  upsertUserRole,
  revokeUserRole,
  getModuleForRole,
  getDisplayRole,
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

    // user_roles es la fuente única. Si la tabla aún no existe (entornos
    // pre-migración), degrada gracilmente con array vacío.
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

    const roles = Array.from(new Set(assignments.map((a) => a.role)));
    // Display role: el rol "principal" para mostrar como badge único o
    // decidir HOME_ROUTES post-login.
    const displayRole = getDisplayRole(roles) ?? data.role;

    return {
      ...data,
      role: displayRole, // sobrescribe la columna huérfana profiles.role
      roles,
      role_assignments: assignments,
    };
  }

  /**
   * Asigna un rol al usuario en el módulo correspondiente al rol.
   * Si ya tiene OTROS roles activos en el mismo módulo, los revoca para
   * que solo quede el rol nuevo (semántica de "cambiar el rol del módulo").
   *
   * Notas:
   *  - profiles.role NO se actualiza — es columna huérfana.
   *  - Roles en OTROS módulos no se ven afectados.
   *  - Para gestión más fina (varios roles dentro del mismo módulo),
   *    usar /auth/users/:id/roles directamente.
   */
  async updateRole(userId: string, role: string, performedBy?: string) {
    const targetModule = getModuleForRole(role);
    if (!targetModule) {
      throw new BadRequestException(`Rol desconocido: ${role}`);
    }

    // Revocar otros roles activos en el mismo módulo
    const { data: existingRoles } = await this.supabase.db
      .from('user_roles')
      .select('role')
      .eq('profile_id', userId)
      .eq('module', targetModule)
      .eq('is_active', true);

    for (const r of existingRoles ?? []) {
      if (r.role !== role) {
        await revokeUserRole(this.supabase.db, {
          profileId: userId,
          role: r.role,
          revokedBy: performedBy ?? null,
        });
      }
    }

    // Asignar (o reactivar) el rol nuevo
    await upsertUserRole(this.supabase.db, {
      profileId: userId,
      role,
      grantedBy: performedBy ?? null,
    });

    // Devolver perfil enriquecido (con roles[] actualizados)
    return this.getProfile(userId);
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
   *  - Si el email NO existe: crea auth.users + profile (sin role) y registra
   *    el rol indicado en user_roles (única fuente de roles).
   *  - Si el email YA existe: agrega el rol al user existente en user_roles.
   *    Devuelve flag `existing_user_added_role: true` para que el frontend
   *    muestre el mensaje específico.
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
      .select('id, email, full_name, is_active')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    if (existing) {
      if (!existing.is_active) {
        throw new BadRequestException(
          'Ya existe un usuario con este email pero está desactivado. Reactívalo desde la lista en lugar de crear uno nuevo.',
        );
      }
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

    // 3. Actualizar/insertar profile (sin role — el rol va a user_roles)
    const { data: profile, error: profileError } = await this.supabase.db
      .from('profiles')
      .update({
        full_name: dto.full_name,
        position: dto.position || null,
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
          department_id: dto.department_id || null,
        })
        .select('*, departments(id, name)')
        .single();

      if (createError) {
        throw new BadRequestException('Error al crear perfil: ' + createError.message);
      }
      finalProfile = newProfile;
    }

    // 4. Asignar el rol vía user_roles (única fuente)
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

  /**
   * Asigna un rol al usuario en un módulo.
   *
   * Regla de negocio: **un usuario solo puede tener UN rol activo por módulo**.
   * Si ya tiene OTRO rol activo en el mismo módulo, se revoca antes de asignar
   * el nuevo. Si ya tiene exactamente ese rol activo, no hace nada.
   * Si el rol existió pero estaba revocado, se reactiva.
   *
   * Si el caller pasa `allowedModules`, valida que el módulo destino esté
   * permitido (usado para que admin_rh solo pueda tocar capacitación).
   */
  async assignUserRole(
    userId: string,
    module: string,
    role: string,
    grantedBy: string,
    allowedModules?: string[],
    allowedRoles?: string[],
  ) {
    if (allowedModules && !allowedModules.includes(module)) {
      throw new ForbiddenException(
        `No tienes permiso para gestionar roles del módulo "${module}".`,
      );
    }
    if (allowedRoles && !allowedRoles.includes(role)) {
      throw new ForbiddenException(
        `No tienes permiso para asignar el rol "${role}".`,
      );
    }

    const { data: target } = await this.supabase.db
      .from('profiles')
      .select('id, is_active')
      .eq('id', userId)
      .single();

    if (!target) throw new NotFoundException('Usuario no encontrado');
    if (!target.is_active) {
      throw new BadRequestException('No se pueden asignar roles a un usuario desactivado');
    }

    // Revocar otros roles activos en el mismo módulo (regla "1 rol por módulo")
    const { data: othersInModule } = await this.supabase.db
      .from('user_roles')
      .select('id, role')
      .eq('profile_id', userId)
      .eq('module', module)
      .eq('is_active', true);

    for (const other of othersInModule ?? []) {
      if (other.role !== role) {
        await this.supabase.db
          .from('user_roles')
          .update({
            is_active: false,
            revoked_at: new Date().toISOString(),
            revoked_by: grantedBy,
          })
          .eq('id', other.id);
      }
    }

    // Si ya existe una fila exacta (activa o revocada), reactivarla
    const { data: existing } = await this.supabase.db
      .from('user_roles')
      .select('id, is_active')
      .eq('profile_id', userId)
      .eq('module', module)
      .eq('role', role)
      .maybeSingle();

    if (existing) {
      if (existing.is_active) return existing;
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

  /**
   * Revoca una asignación de rol (soft delete: is_active=false + revoked_at).
   * Si se pasa `allowedModules`, valida que el rol revocado esté en uno de
   * ellos (usado para limitar admin_rh a capacitación).
   */
  async revokeUserRole(
    roleId: string,
    revokedBy: string,
    allowedModules?: string[],
    allowedRoles?: string[],
  ) {
    if (allowedModules || allowedRoles) {
      const { data: existing } = await this.supabase.db
        .from('user_roles')
        .select('module, role')
        .eq('id', roleId)
        .maybeSingle();
      if (!existing) {
        throw new NotFoundException('Asignación de rol no encontrada');
      }
      if (allowedModules && !allowedModules.includes(existing.module)) {
        throw new ForbiddenException(
          `No tienes permiso para revocar roles del módulo "${existing.module}".`,
        );
      }
      if (allowedRoles && !allowedRoles.includes(existing.role)) {
        throw new ForbiddenException(
          `No tienes permiso para revocar el rol "${existing.role}".`,
        );
      }
    }

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
