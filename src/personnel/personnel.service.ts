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
   * Modelo: user_roles es la fuente única. Un usuario aparece aquí si
   * tiene al menos un rol de personnel (`colaborador`, `jefe_area`, etc.)
   * en el módulo `capacitacion` — activo o inactivo.
   *
   * El campo `is_active` en cada item refleja si su rol DE CAPACITACIÓN
   * está activo (no si su cuenta global está activa).
   *
   * Cada item tiene además un campo `role` con el rol efectivo en este
   * módulo (priorizado: jefe_area > director > colaborador > collaborator).
   */
  async findAll(filters?: PersonnelFilters) {
    // 1) user_roles del módulo capacitación con roles de personnel.
    //    Incluye activos e inactivos para soportar la lista de "bajas".
    const { data: roleRows, error: rolesErr } = await this.supabase.db
      .from('user_roles')
      .select('profile_id, role, is_active')
      .eq('module', 'capacitacion')
      .in('role', PERSONNEL_ROLES_FILTER);
    if (rolesErr) throw rolesErr;

    if (!roleRows || roleRows.length === 0) return [];

    // Agrupar por profile_id: roles activos vs inactivos
    const activeByProfile = new Map<string, Set<string>>();
    const inactiveByProfile = new Map<string, Set<string>>();
    for (const r of roleRows) {
      const map = r.is_active ? activeByProfile : inactiveByProfile;
      if (!map.has(r.profile_id)) map.set(r.profile_id, new Set());
      map.get(r.profile_id)!.add(r.role);
    }

    const profileIds = Array.from(
      new Set([
        ...activeByProfile.keys(),
        ...inactiveByProfile.keys(),
      ]),
    );

    // 2) Traer profiles
    const { data: profiles } = await this.supabase.db
      .from('profiles')
      .select('*, departments(id, name)')
      .in('id', profileIds);

    const priority = ['jefe_area', 'director', 'colaborador', 'collaborator'];
    const pickEffective = (roles: Set<string> | undefined): string | null => {
      if (!roles) return null;
      for (const r of priority) if (roles.has(r)) return r;
      return null;
    };

    // 3) Enriquecer cada profile con role efectivo y is_active de capacitación
    let result = (profiles ?? []).map((p) => {
      const active = activeByProfile.get(p.id);
      const inactive = inactiveByProfile.get(p.id);
      const hasActiveRole = !!active && active.size > 0;
      const effective = pickEffective(active) ?? pickEffective(inactive) ?? 'colaborador';
      return {
        ...p,
        role: effective,
        // is_active: combina el de la cuenta global y el del rol en capacitación
        is_active: p.is_active && hasActiveRole,
      };
    });

    // 4) Filtros
    if (filters?.department_id) {
      result = result.filter((p) => p.department_id === filters.department_id);
    }
    if (filters?.is_active !== undefined) {
      result = result.filter((p) => p.is_active === filters.is_active);
    }
    if (filters?.role && PERSONNEL_ROLES_FILTER.includes(filters.role)) {
      result = result.filter((p) => p.role === filters.role);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(
        (p) =>
          p.full_name?.toLowerCase().includes(q) ||
          p.email?.toLowerCase().includes(q) ||
          p.position?.toLowerCase().includes(q),
      );
    }

    result.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    return result;
  }

  /**
   * Get a single personnel record.
   * Devuelve el perfil con el rol efectivo en capacitación.
   */
  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from('profiles')
      .select('*, departments(id, name)')
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Colaborador no encontrado');

    const { data: roleRows } = await this.supabase.db
      .from('user_roles')
      .select('role, is_active')
      .eq('profile_id', id)
      .eq('module', 'capacitacion')
      .in('role', PERSONNEL_ROLES_FILTER);

    const active = new Set((roleRows ?? []).filter((r) => r.is_active).map((r) => r.role));
    const inactive = new Set((roleRows ?? []).filter((r) => !r.is_active).map((r) => r.role));
    const priority = ['jefe_area', 'director', 'colaborador', 'collaborator'];
    let effective: string = 'colaborador';
    for (const r of priority) {
      if (active.has(r) || inactive.has(r)) {
        effective = r;
        break;
      }
    }

    return {
      ...data,
      role: effective,
      is_active: data.is_active && active.size > 0,
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

    // 3. Actualizar/insertar profile (sin role — se asigna en user_roles)
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
      role,
      grantedBy: performedBy ?? null,
    });

    return finalProfile;
  }

  /**
   * Update collaborator data.
   *
   * Atributos del PERSONA (nombre, posición, departamento) siempre editables.
   * El rol se gestiona en user_roles del módulo capacitación: si se pasa un
   * rol nuevo, se revocan los demás de personnel en cap. y se asigna el nuevo.
   */
  async update(id: string, dto: UpdatePersonnelDto, performedBy?: string) {
    const existing = await this.findOne(id);
    if (!existing) throw new NotFoundException('Colaborador no encontrado');

    if (dto.role && !PERSONNEL_ROLES_FILTER.includes(dto.role)) {
      throw new BadRequestException('Rol no permitido en este módulo');
    }

    // Atributos del usuario (sin role — el rol va en user_roles)
    const updatePayload: Record<string, unknown> = {};
    if (dto.full_name !== undefined) updatePayload.full_name = dto.full_name;
    if (dto.position !== undefined) updatePayload.position = dto.position;
    if (dto.department_id !== undefined) updatePayload.department_id = dto.department_id;

    if (Object.keys(updatePayload).length > 0) {
      const { error } = await this.supabase.db
        .from('profiles')
        .update(updatePayload)
        .eq('id', id);
      if (error) throw new BadRequestException('Error al actualizar: ' + error.message);
    }

    // Cambio de rol: revocar otros roles de personnel en módulo capacitación
    // y asignar el nuevo. Roles en otros módulos no se ven afectados.
    if (dto.role && dto.role !== existing.role) {
      const { data: existingCapRoles } = await this.supabase.db
        .from('user_roles')
        .select('role')
        .eq('profile_id', id)
        .eq('module', 'capacitacion')
        .in('role', PERSONNEL_ROLES_FILTER)
        .eq('is_active', true);

      for (const r of existingCapRoles ?? []) {
        if (r.role !== dto.role) {
          await revokeUserRole(this.supabase.db, {
            profileId: id,
            role: r.role,
            revokedBy: performedBy ?? null,
          });
        }
      }

      await upsertUserRole(this.supabase.db, {
        profileId: id,
        role: dto.role,
        grantedBy: performedBy ?? null,
      });
    }

    return this.findOne(id);
  }

  /**
   * "Dar de baja" desde /personal:
   *   Revoca TODOS los roles de personnel del usuario en módulo capacitación.
   *   La cuenta global (profiles.is_active) NO se toca — si el usuario tiene
   *   roles en otros módulos, ahí sigue funcionando.
   *
   *   Para desactivar globalmente al usuario (cerrar la cuenta), usar
   *   /admin/users (super_admin).
   */
  async deactivate(id: string, performedBy?: string) {
    const { data: roles } = await this.supabase.db
      .from('user_roles')
      .select('role')
      .eq('profile_id', id)
      .eq('module', 'capacitacion')
      .in('role', PERSONNEL_ROLES_FILTER)
      .eq('is_active', true);

    for (const r of roles ?? []) {
      await revokeUserRole(this.supabase.db, {
        profileId: id,
        role: r.role,
        revokedBy: performedBy ?? null,
      });
    }

    return this.findOne(id);
  }

  /**
   * Reactivar: vuelve a activar los user_roles previamente revocados del
   * usuario en módulo capacitación. Si nunca tuvo roles, no hace nada.
   */
  async reactivate(id: string, performedBy?: string) {
    const { data: roles } = await this.supabase.db
      .from('user_roles')
      .select('role')
      .eq('profile_id', id)
      .eq('module', 'capacitacion')
      .in('role', PERSONNEL_ROLES_FILTER)
      .eq('is_active', false);

    for (const r of roles ?? []) {
      await upsertUserRole(this.supabase.db, {
        profileId: id,
        role: r.role,
        grantedBy: performedBy ?? null,
      });
    }

    return this.findOne(id);
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
