import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LocalAuthService } from '../auth/services/local-auth.service';
import { CreatePersonnelDto } from './dto/create-personnel.dto';
import { UpdatePersonnelDto } from './dto/update-personnel.dto';
import {
  upsertUserRole,
  revokeUserRole,
  getModuleForRole,
} from '../common/services/user-roles.helper';

// Roles administrables desde el módulo de personal por admin_rh.
// Incluye 'collaborator' (legacy) para mantener compatibilidad de lectura.
const PERSONNEL_ROLES_FILTER = [
  'colaborador',
  'collaborator',
  'jefe_area',
  'director',
];

interface PersonnelFilters {
  department_id?: string;
  is_active?: boolean;
  search?: string;
  role?: string;
}

@Injectable()
export class PersonnelService {
  /**
   * Fase 2: el alta ya NO crea cuenta en Supabase Auth. Solo registra el
   * profile en PG local con `pending_first_login=true`. Si `ALLOW_LOCAL_LOGIN=true`
   * y se pasa password, también se crea `local_credentials`.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly local: LocalAuthService,
  ) {}

  /**
   * Lista de personal de capacitación. user_roles es la fuente única.
   */
  async findAll(filters?: PersonnelFilters) {
    // 1) user_roles del módulo capacitación con roles de personnel
    const roleRows = await this.prisma.user_roles.findMany({
      where: {
        module: 'capacitacion',
        role: { in: PERSONNEL_ROLES_FILTER as never[] },
      },
      select: { profile_id: true, role: true, is_active: true },
    });

    if (roleRows.length === 0) return [];

    const activeByProfile = new Map<string, Set<string>>();
    const inactiveByProfile = new Map<string, Set<string>>();
    for (const r of roleRows) {
      const map = r.is_active ? activeByProfile : inactiveByProfile;
      if (!map.has(r.profile_id)) map.set(r.profile_id, new Set());
      map.get(r.profile_id)!.add(r.role);
    }

    const profileIds = Array.from(
      new Set([...activeByProfile.keys(), ...inactiveByProfile.keys()]),
    );

    // 2) Traer profiles
    const profiles = await this.prisma.profiles.findMany({
      where: { id: { in: profileIds } },
      include: { departments: { select: { id: true, name: true } } },
    });

    const priority = ['jefe_area', 'director', 'colaborador', 'collaborator'];
    const pickEffective = (roles: Set<string> | undefined): string | null => {
      if (!roles) return null;
      for (const r of priority) if (roles.has(r)) return r;
      return null;
    };

    // 3) Enriquecer
    let result = profiles.map((p) => {
      const active = activeByProfile.get(p.id);
      const inactive = inactiveByProfile.get(p.id);
      const hasActiveRole = !!active && active.size > 0;
      const effective =
        pickEffective(active) ?? pickEffective(inactive) ?? 'colaborador';
      return {
        ...p,
        role: effective,
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

    result.sort((a, b) =>
      (a.full_name || '').localeCompare(b.full_name || ''),
    );
    return result;
  }

  async findOne(id: string) {
    const data = await this.prisma.profiles.findUnique({
      where: { id },
      include: { departments: { select: { id: true, name: true } } },
    });
    if (!data) throw new NotFoundException('Colaborador no encontrado');

    const roleRows = await this.prisma.user_roles.findMany({
      where: {
        profile_id: id,
        module: 'capacitacion',
        role: { in: PERSONNEL_ROLES_FILTER as never[] },
      },
      select: { role: true, is_active: true },
    });

    const active = new Set<string>(
      roleRows.filter((r) => r.is_active).map((r) => r.role as string),
    );
    const inactive = new Set<string>(
      roleRows.filter((r) => !r.is_active).map((r) => r.role as string),
    );
    const priority = ['jefe_area', 'director', 'colaborador', 'collaborator'];
    let effective = 'colaborador';
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
   * Alta de colaborador (admin_rh) — modelo K-7.
   * Si el email existe, agrega el rol al user existente. Si es nuevo, crea
   * el profile en PG local con `pending_first_login=true` y, si se pasó
   * password con login local habilitado, también la credencial local.
   */
  async create(dto: CreatePersonnelDto, performedBy?: string) {
    const role = dto.role || 'colaborador';
    const normalizedEmail = dto.email.trim().toLowerCase();

    const existing = await this.prisma.profiles.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      select: {
        id: true,
        email: true,
        full_name: true,
        role: true,
        is_active: true,
      },
    });

    if (existing) {
      if (!existing.is_active) {
        throw new BadRequestException(
          'Ya existe un usuario con este email pero está desactivado. Reactívalo desde la lista en lugar de crear uno nuevo.',
        );
      }
      await upsertUserRole(this.prisma, {
        profileId: existing.id,
        role,
        grantedBy: performedBy ?? null,
      });

      if (dto.password && this.local.isEnabled()) {
        await this.local.setPassword(existing.id, dto.password, {
          mustChangePassword: true,
          performedBy,
        });
      }

      const enriched = await this.prisma.profiles.findUnique({
        where: { id: existing.id },
        include: { departments: { select: { id: true, name: true } } },
      });

      return {
        ...enriched,
        existing_user_added_role: true,
        added_role: role,
        added_module: getModuleForRole(role),
      };
    }

    if (!dto.full_name?.trim()) {
      throw new BadRequestException('El nombre completo es requerido');
    }
    if (dto.password && dto.password.length < 6) {
      throw new BadRequestException(
        'La contraseña debe tener al menos 6 caracteres',
      );
    }

    const profile = await this.prisma.profiles.create({
      data: {
        email: dto.email,
        full_name: dto.full_name,
        position: dto.position || null,
        department_id: dto.department_id || null,
      },
      include: { departments: { select: { id: true, name: true } } },
    });

    await upsertUserRole(this.prisma, {
      profileId: profile.id,
      role,
      grantedBy: performedBy ?? null,
    });

    if (dto.password && this.local.isEnabled()) {
      await this.local.setPassword(profile.id, dto.password, {
        mustChangePassword: true,
        performedBy,
      });
    }

    return profile;
  }

  /**
   * Update collaborator data. Atributos de la persona siempre editables.
   * Si se pasa rol nuevo, se revocan los demás de personnel en capacitación
   * y se asigna el nuevo.
   */
  async update(id: string, dto: UpdatePersonnelDto, performedBy?: string) {
    const existing = await this.findOne(id);
    if (!existing) throw new NotFoundException('Colaborador no encontrado');

    if (dto.role && !PERSONNEL_ROLES_FILTER.includes(dto.role)) {
      throw new BadRequestException('Rol no permitido en este módulo');
    }

    const updatePayload: Record<string, unknown> = {};
    if (dto.full_name !== undefined) updatePayload.full_name = dto.full_name;
    if (dto.position !== undefined) updatePayload.position = dto.position;
    if (dto.department_id !== undefined)
      updatePayload.department_id = dto.department_id;

    if (Object.keys(updatePayload).length > 0) {
      try {
        await this.prisma.profiles.update({
          where: { id },
          data: updatePayload,
        });
      } catch (err: unknown) {
        const msg = (err as { message?: string })?.message ?? 'unknown';
        throw new BadRequestException('Error al actualizar: ' + msg);
      }
    }

    if (dto.role && dto.role !== existing.role) {
      const existingCapRoles = await this.prisma.user_roles.findMany({
        where: {
          profile_id: id,
          module: 'capacitacion',
          role: { in: PERSONNEL_ROLES_FILTER as never[] },
          is_active: true,
        },
        select: { role: true },
      });

      for (const r of existingCapRoles) {
        if (r.role !== dto.role) {
          await revokeUserRole(this.prisma, {
            profileId: id,
            role: r.role,
            revokedBy: performedBy ?? null,
          });
        }
      }

      await upsertUserRole(this.prisma, {
        profileId: id,
        role: dto.role,
        grantedBy: performedBy ?? null,
      });
    }

    return this.findOne(id);
  }

  /**
   * "Dar de baja" — revoca TODOS los roles de personnel en capacitación.
   * La cuenta global (profiles.is_active) NO se toca.
   */
  async deactivate(id: string, performedBy?: string) {
    const roles = await this.prisma.user_roles.findMany({
      where: {
        profile_id: id,
        module: 'capacitacion',
        role: { in: PERSONNEL_ROLES_FILTER as never[] },
        is_active: true,
      },
      select: { role: true },
    });

    for (const r of roles) {
      await revokeUserRole(this.prisma, {
        profileId: id,
        role: r.role,
        revokedBy: performedBy ?? null,
      });
    }

    return this.findOne(id);
  }

  /**
   * Reactivar — vuelve a activar los user_roles previamente revocados del
   * usuario en módulo capacitación.
   */
  async reactivate(id: string, performedBy?: string) {
    const roles = await this.prisma.user_roles.findMany({
      where: {
        profile_id: id,
        module: 'capacitacion',
        role: { in: PERSONNEL_ROLES_FILTER as never[] },
        is_active: false,
      },
      select: { role: true },
    });

    for (const r of roles) {
      await upsertUserRole(this.prisma, {
        profileId: id,
        role: r.role,
        grantedBy: performedBy ?? null,
      });
    }

    return this.findOne(id);
  }

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
        byDepartment[p.department_id] =
          (byDepartment[p.department_id] || 0) + 1;
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
