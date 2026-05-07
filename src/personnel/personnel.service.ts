import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreatePersonnelDto } from './dto/create-personnel.dto';
import { UpdatePersonnelDto } from './dto/update-personnel.dto';
import {
  upsertUserRole,
  revokeUserRole,
  getModuleForRole,
} from '../common/services/user-roles.helper';

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
   * Lista de personal de capacitación.
   *
   * Incluye:
   *  - Usuarios cuyo rol primario (profiles.role) es de personnel
   *    (colaborador, collaborator, jefe_area, director).
   *  - Usuarios "compartidos": tienen rol primario de OTRO módulo
   *    (ej. aprobador_nivel_3 en Compras) pero también tienen un rol
   *    de personnel en el módulo capacitacion vía user_roles.
   *
   * Para los compartidos, sobreescribimos el campo `role` con el rol
   * efectivo en este módulo y agregamos un flag `is_shared_user`
   * para que el frontend pueda mostrar un indicador visual.
   */
  async findAll(filters?: PersonnelFilters) {
    // 1) Usuarios con rol primario de personnel
    const { data: byPrimary, error: primaryErr } = await this.supabase.db
      .from('profiles')
      .select('*, departments(id, name)')
      .in('role', PERSONNEL_ROLES_FILTER);
    if (primaryErr) throw primaryErr;

    // 2) Asignaciones de personnel en user_roles (módulo capacitación, activas)
    const { data: extraRoles } = await this.supabase.db
      .from('user_roles')
      .select('profile_id, role')
      .eq('module', 'capacitacion')
      .in('role', PERSONNEL_ROLES_FILTER)
      .eq('is_active', true);

    // Map profile_id → set de roles de personnel en user_roles
    const userRolesByProfile = new Map<string, Set<string>>();
    for (const r of extraRoles ?? []) {
      if (!userRolesByProfile.has(r.profile_id)) {
        userRolesByProfile.set(r.profile_id, new Set());
      }
      userRolesByProfile.get(r.profile_id)!.add(r.role);
    }

    // 3) Traer perfiles que están en user_roles pero NO en byPrimary
    const profilesById = new Map<string, any>();
    for (const p of byPrimary ?? []) profilesById.set(p.id, p);
    const missingIds = [...userRolesByProfile.keys()].filter((id) => !profilesById.has(id));
    if (missingIds.length > 0) {
      const { data: extras } = await this.supabase.db
        .from('profiles')
        .select('*, departments(id, name)')
        .in('id', missingIds);
      for (const p of extras ?? []) profilesById.set(p.id, p);
    }

    // 4) Enriquecer cada perfil con el rol "efectivo en capacitación" y flag de compartido
    const priority = ['jefe_area', 'director', 'colaborador', 'collaborator'];
    const pickEffective = (roles: Set<string> | undefined): string | null => {
      if (!roles) return null;
      for (const r of priority) if (roles.has(r)) return r;
      return null;
    };

    let result = Array.from(profilesById.values()).map((p) => {
      const isShared = !PERSONNEL_ROLES_FILTER.includes(p.role);
      const effectiveRole = isShared ? pickEffective(userRolesByProfile.get(p.id)) : p.role;
      return {
        ...p,
        role: effectiveRole ?? p.role,
        primary_role: p.role,
        is_shared_user: isShared,
      };
    });

    // 5) Filtros JS (más simple que armar OR complejos en Postgrest)
    if (filters?.department_id) {
      result = result.filter((p) => p.department_id === filters.department_id);
    }
    if (filters?.is_active !== undefined) {
      result = result.filter((p) => p.is_active === filters.is_active);
    }
    if (filters?.role && PERSONNEL_ROLES_FILTER.includes(filters.role)) {
      // Filtro por rol: aplica sobre el rol "efectivo" en capacitación
      result = result.filter((p) => p.role === filters.role);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      result = result.filter((p) =>
        (p.full_name?.toLowerCase().includes(q)) ||
        (p.email?.toLowerCase().includes(q)) ||
        (p.position?.toLowerCase().includes(q)),
      );
    }

    result.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    return result;
  }

  /**
   * Get a single personnel record. Igual que findAll, soporta usuarios
   * "compartidos" — devuelve el rol efectivo en capacitación.
   */
  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('profiles')
      .select('*, departments(id, name)')
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Colaborador no encontrado');

    const isShared = !PERSONNEL_ROLES_FILTER.includes(data.role);
    if (!isShared) return data;

    // Es un usuario compartido — buscar su rol efectivo de capacitación
    const { data: extraRoles } = await this.supabase.db
      .from('user_roles')
      .select('role')
      .eq('profile_id', id)
      .eq('module', 'capacitacion')
      .in('role', PERSONNEL_ROLES_FILTER)
      .eq('is_active', true);

    const roles = new Set((extraRoles ?? []).map((r) => r.role));
    const priority = ['jefe_area', 'director', 'colaborador', 'collaborator'];
    let effectiveRole: string | null = null;
    for (const r of priority) {
      if (roles.has(r)) {
        effectiveRole = r;
        break;
      }
    }

    return {
      ...data,
      role: effectiveRole ?? data.role,
      primary_role: data.role,
      is_shared_user: true,
    };
  }

  /**
   * Alta de colaborador (admin_rh).
   *
   * Lógica multi-módulo: si el email ya existe (porque está dado de alta
   * en otro módulo, p.ej. Compras), NO crea duplicado — solo le suma el rol
   * de capacitación en user_roles. Si el email es nuevo, crea todo.
   */
  async create(dto: CreatePersonnelDto, performedBy?: string) {
    const role = dto.role || 'colaborador';
    const normalizedEmail = dto.email.trim().toLowerCase();

    // 1. ¿Existe ya el email? (case-insensitive — auth.users normaliza a
    //    lowercase, pero profiles.email puede tener variaciones de capitalización
    //    según cómo se haya creado el registro)
    const { data: existing } = await this.supabase.db
      .from('profiles')
      .select('id, email, full_name, role, is_active')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    if (existing) {
      if (!existing.is_active) {
        throw new BadRequestException(
          'Ya existe un usuario con este email pero está desactivado. Reactívalo desde la lista en lugar de crear uno nuevo.',
        );
      }
      // Solo agregar el rol de capacitación al usuario existente
      await upsertUserRole(this.supabase.db, {
        profileId: existing.id,
        role,
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
        added_role: role,
        added_module: getModuleForRole(role),
      };
    }

    // 2. Email nuevo — para crear cuenta nueva sí necesitamos password y nombre
    if (!dto.password || dto.password.length < 6) {
      throw new BadRequestException(
        'La contraseña es requerida y debe tener al menos 6 caracteres',
      );
    }
    if (!dto.full_name?.trim()) {
      throw new BadRequestException('El nombre completo es requerido');
    }

    const { data: authData, error: authError } =
      await this.supabase.db.auth.admin.createUser({
        email: dto.email,
        password: dto.password,
        email_confirm: true,
        user_metadata: { full_name: dto.full_name },
      });

    if (authError) {
      if (authError.message.includes('already been registered')) {
        // race condition: alguien lo creó entre nuestro check y este insert.
        // Reintenta como "agregar rol al existente".
        const { data: late } = await this.supabase.db
          .from('profiles')
          .select('id, is_active')
          .ilike('email', normalizedEmail)
          .maybeSingle();
        if (late?.id) {
          await upsertUserRole(this.supabase.db, {
            profileId: late.id,
            role,
            grantedBy: performedBy ?? null,
          });
          const { data: enriched } = await this.supabase.db
            .from('profiles')
            .select('*, departments(id, name)')
            .eq('id', late.id)
            .single();
          return {
            ...enriched,
            existing_user_added_role: true,
            added_role: role,
            added_module: getModuleForRole(role),
          };
        }
        throw new BadRequestException('El correo electrónico ya está registrado');
      }
      throw new BadRequestException(authError.message);
    }

    const userId = authData.user.id;

    // 3. Actualizar/insertar profile
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

    let finalProfile = profile;
    if (profileError) {
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
      finalProfile = newProfile;
    }

    // 4. Sincronizar user_roles
    await upsertUserRole(this.supabase.db, {
      profileId: userId,
      role,
      grantedBy: performedBy ?? null,
    });

    return finalProfile;
  }

  /**
   * Update collaborator data.
   *
   * Distingue dos casos:
   *  - Usuario puro de capacitación (primary_role ∈ PERSONNEL_ROLES_FILTER):
   *    se actualiza profiles (nombre, posición, depto, rol) + user_roles si
   *    cambió el rol.
   *  - Usuario compartido (primary_role en otro módulo): SOLO se permite
   *    cambiar el rol de capacitación en user_roles. Los demás campos
   *    (nombre, posición, depto) se ignoran porque no son responsabilidad
   *    de admin_rh — pertenecen al módulo "dueño" del rol primario.
   */
  async update(id: string, dto: UpdatePersonnelDto, performedBy?: string) {
    const existing = await this.findOne(id);
    if (!existing) throw new NotFoundException('Colaborador no encontrado');

    if (dto.role && !PERSONNEL_ROLES_FILTER.includes(dto.role)) {
      throw new BadRequestException('Rol no permitido en este módulo');
    }

    const isShared = !!existing.is_shared_user;
    const oldEffectiveRole = existing.role; // ya enriquecido por findOne

    if (isShared) {
      // Solo manejar user_roles del módulo capacitación
      if (dto.role && dto.role !== oldEffectiveRole) {
        await revokeUserRole(this.supabase.db, {
          profileId: id,
          role: oldEffectiveRole,
          revokedBy: performedBy ?? null,
        });
        await upsertUserRole(this.supabase.db, {
          profileId: id,
          role: dto.role,
          grantedBy: performedBy ?? null,
        });
      }
      // Recargar para devolver el perfil con el nuevo rol efectivo
      return this.findOne(id);
    }

    // Usuario puro de capacitación: comportamiento estándar
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

    // Sincronizar user_roles si cambió el rol primario
    if (dto.role && dto.role !== oldEffectiveRole) {
      await revokeUserRole(this.supabase.db, {
        profileId: id,
        role: oldEffectiveRole,
        revokedBy: performedBy ?? null,
      });
      await upsertUserRole(this.supabase.db, {
        profileId: id,
        role: dto.role,
        grantedBy: performedBy ?? null,
      });
    }

    return data;
  }

  /**
   * Soft delete - deactivate collaborator.
   *
   * Si el usuario es "compartido" (rol primario en otro módulo), se BLOQUEA
   * la operación porque desactivar profiles.is_active afectaría también su
   * acceso al otro módulo. El admin debe ir a /admin/users (super_admin) y
   * revocar específicamente el rol de capacitación desde el modal de roles.
   */
  async deactivate(id: string) {
    const existing = await this.findOne(id);
    if (existing.is_shared_user) {
      throw new BadRequestException(
        'Este usuario también tiene rol primario en otro módulo. No se puede desactivar desde aquí. Pide a un super_admin que revoque su rol de capacitación desde Admin → Usuarios.',
      );
    }

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
   * Reactivate collaborator.
   * Mismo principio: si es compartido, no debería estar desactivado, así que
   * tampoco se reactiva desde aquí.
   */
  async reactivate(id: string) {
    const existing = await this.findOne(id);
    if (existing.is_shared_user) {
      throw new BadRequestException(
        'Este usuario también tiene rol primario en otro módulo y debe gestionarse desde Admin → Usuarios.',
      );
    }

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
   * Stats de personal de capacitación. Reutiliza findAll() para que el conteo
   * incluya tanto a los usuarios con rol primario de personnel como a los
   * "compartidos" (con rol secundario en módulo capacitación).
   */
  async getStats() {
    const all = await this.findAll();

    const total = all.length;
    const active = all.filter((p) => p.is_active).length;
    const inactive = total - active;

    const collaborators = all.filter(
      (p) => ['colaborador', 'collaborator'].includes(p.role) && p.is_active,
    ).length;
    const managers = all.filter(
      (p) => ['jefe_area', 'director'].includes(p.role) && p.is_active,
    ).length;

    const byDepartment: Record<string, number> = {};
    for (const p of all) {
      if (p.department_id && p.is_active) {
        byDepartment[p.department_id] = (byDepartment[p.department_id] || 0) + 1;
      }
    }

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
