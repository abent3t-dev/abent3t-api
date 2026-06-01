import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LocalAuthService } from './services/local-auth.service';
import {
  upsertUserRole,
  revokeUserRole,
  getModuleForRole,
  getDisplayRole,
} from '../common/services/user-roles.helper';

interface CreateUserDto {
  email: string;
  /** Opcional desde Fase 2: si se pasa, se setea como credencial local
   *  (login email+password). Si no, el usuario solo podrá entrar vía OIDC
   *  cuando Entra ID esté configurado. */
  password?: string;
  full_name: string;
  position?: string;
  role?: string;
  department_id?: string;
}

@Injectable()
export class AuthService {
  /**
   * Fase 2: la identidad ya NO depende de Supabase Auth. El alta crea solo
   * el `profile` (modelo K-7 — pre-registro con `pending_first_login=true`)
   * y opcionalmente una `local_credentials` si se pasa password. El primer
   * login (OIDC o local) baja `pending_first_login` a false.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly local: LocalAuthService,
  ) {}

  /**
   * Busca un usuario por email (case-insensitive) y devuelve su info básica
   * + roles asignados por módulo. Usado por la UI de alta de usuarios para
   * detectar duplicados antes del submit.
   */
  async lookupByEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return { exists: false as const };

    const profile = await this.prisma.profiles.findFirst({
      where: { email: { equals: normalized, mode: 'insensitive' } },
      select: {
        id: true,
        full_name: true,
        email: true,
        position: true,
        role: true,
        is_active: true,
        departments: { select: { id: true, name: true } },
      },
    });

    if (!profile) return { exists: false as const };

    const roles_by_module = await this.prisma.user_roles.findMany({
      where: { profile_id: profile.id, is_active: true },
      select: { module: true, role: true },
    });

    return {
      exists: true as const,
      profile,
      roles_by_module,
    };
  }

  async getProfile(userId: string) {
    const profile = await this.prisma.profiles.findUnique({
      where: { id: userId },
      include: { departments: { select: { id: true, name: true } } },
    });
    if (!profile) throw new NotFoundException('Perfil no encontrado');

    const assignments = await this.prisma.user_roles.findMany({
      where: { profile_id: userId, is_active: true },
      select: { module: true, role: true },
    });

    const roles = Array.from(new Set(assignments.map((a) => a.role)));
    const displayRole = getDisplayRole(roles) ?? profile.role;

    return {
      ...profile,
      role: displayRole, // sobrescribe la columna huérfana profiles.role
      roles,
      role_assignments: assignments,
    };
  }

  /**
   * Asigna un rol al usuario en el módulo correspondiente al rol.
   * Revoca otros roles activos en el mismo módulo (regla "1 rol por módulo").
   */
  async updateRole(userId: string, role: string, performedBy?: string) {
    const targetModule = getModuleForRole(role);
    if (!targetModule) {
      throw new BadRequestException(`Rol desconocido: ${role}`);
    }

    const existingRoles = await this.prisma.user_roles.findMany({
      where: { profile_id: userId, module: targetModule, is_active: true },
      select: { role: true },
    });

    for (const r of existingRoles) {
      if (r.role !== role) {
        await revokeUserRole(this.prisma, {
          profileId: userId,
          role: r.role,
          revokedBy: performedBy ?? null,
        });
      }
    }

    await upsertUserRole(this.prisma, {
      profileId: userId,
      role,
      grantedBy: performedBy ?? null,
    });

    return this.getProfile(userId);
  }

  async assignDepartment(userId: string, departmentId: string) {
    try {
      return await this.prisma.profiles.update({
        where: { id: userId },
        data: { department_id: departmentId },
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2025') {
        throw new NotFoundException('Perfil no encontrado');
      }
      throw err;
    }
  }

  async listUsers(filters?: {
    role?: string;
    department_id?: string;
    is_active?: boolean;
  }) {
    const where: Prisma.profilesWhereInput = {};
    if (filters?.role) where.role = filters.role as never;
    if (filters?.department_id) where.department_id = filters.department_id;
    if (filters?.is_active !== undefined) where.is_active = filters.is_active;

    return this.prisma.profiles.findMany({
      where,
      include: { departments: { select: { id: true, name: true } } },
      orderBy: { full_name: 'asc' },
    });
  }

  async deactivateUser(userId: string) {
    try {
      return await this.prisma.profiles.update({
        where: { id: userId },
        data: { is_active: false, deactivated_at: new Date() },
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2025') {
        throw new NotFoundException('Perfil no encontrado');
      }
      throw err;
    }
  }

  /**
   * Alta de usuario (Fase 2 — modelo K-7).
   *
   * No crea cuenta en ningún IdP externo: solo registra el `profile` en
   * PG local con `pending_first_login=true`. El primer login (Microsoft o
   * email+password si ALLOW_LOCAL_LOGIN=true) baja el flag.
   *
   *  - Si el email YA existe: agrega el rol al user existente en user_roles.
   *    Devuelve `existing_user_added_role: true`.
   *  - Si el email es nuevo: crea profile + user_roles. Si se pasa `password`,
   *    también crea `local_credentials` con `must_change_password=true`
   *    (modo dev — para usar con /auth/login-local).
   */
  async createUser(dto: CreateUserDto, performedBy?: string) {
    if (!dto.email) {
      throw new BadRequestException('El email es requerido');
    }

    const targetRole = dto.role || 'colaborador';
    const normalizedEmail = dto.email.trim().toLowerCase();

    // 1. ¿Ya existe en PG local?
    const existing = await this.prisma.profiles.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      select: { id: true, email: true, full_name: true, is_active: true },
    });

    if (existing) {
      if (!existing.is_active) {
        throw new BadRequestException(
          'Ya existe un usuario con este email pero está desactivado. Reactívalo desde la lista en lugar de crear uno nuevo.',
        );
      }
      await upsertUserRole(this.prisma, {
        profileId: existing.id,
        role: targetRole,
        grantedBy: performedBy ?? null,
      });

      // Si el caller envió password, también actualizamos las credenciales locales.
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
        added_role: targetRole,
        added_module: getModuleForRole(targetRole),
      };
    }

    // 2. Email nuevo: validar nombre. El password ahora es opcional —
    // solo se requiere si se quiere habilitar login local desde el inicio.
    if (!dto.full_name?.trim()) {
      throw new BadRequestException('El nombre completo es requerido');
    }
    if (dto.password && dto.password.length < 6) {
      throw new BadRequestException(
        'La contraseña debe tener al menos 6 caracteres',
      );
    }

    // 3. Crear profile (pending_first_login=true viene por DEFAULT del schema).
    const profile = await this.prisma.profiles.create({
      data: {
        email: dto.email,
        full_name: dto.full_name,
        position: dto.position || null,
        department_id: dto.department_id || null,
      },
      include: { departments: { select: { id: true, name: true } } },
    });

    // 4. Asignar el rol vía user_roles.
    await upsertUserRole(this.prisma, {
      profileId: profile.id,
      role: targetRole,
      grantedBy: performedBy ?? null,
    });

    // 5. Si se pasó password y el login local está habilitado, crear credencial.
    //    must_change_password=true → el usuario debe cambiarla en el primer login.
    if (dto.password && this.local.isEnabled()) {
      await this.local.setPassword(profile.id, dto.password, {
        mustChangePassword: true,
        performedBy,
      });
    }

    return profile;
  }

  async reactivateUser(userId: string) {
    try {
      return await this.prisma.profiles.update({
        where: { id: userId },
        data: { is_active: true, deactivated_at: null },
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2025') {
        throw new NotFoundException('Perfil no encontrado');
      }
      throw err;
    }
  }

  // =====================================================
  // GESTIÓN DE ROLES POR MÓDULO (user_roles)
  // =====================================================

  async listUserRoles(userId: string) {
    return this.prisma.user_roles.findMany({
      where: { profile_id: userId },
      select: {
        id: true,
        profile_id: true,
        module: true,
        role: true,
        granted_at: true,
        revoked_at: true,
        is_active: true,
        profiles_user_roles_granted_byToprofiles: {
          select: { id: true, full_name: true, email: true },
        },
      },
      orderBy: [{ module: 'asc' }, { role: 'asc' }],
    });
  }

  /**
   * Asigna un rol al usuario en un módulo (regla "1 rol por módulo").
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

    const target = await this.prisma.profiles.findUnique({
      where: { id: userId },
      select: { id: true, is_active: true },
    });
    if (!target) throw new NotFoundException('Usuario no encontrado');
    if (!target.is_active) {
      throw new BadRequestException(
        'No se pueden asignar roles a un usuario desactivado',
      );
    }

    // Revocar otros roles activos en el mismo módulo
    await this.prisma.user_roles.updateMany({
      where: {
        profile_id: userId,
        module: module as never,
        is_active: true,
        role: { not: role as never },
      },
      data: {
        is_active: false,
        revoked_at: new Date(),
        revoked_by: grantedBy,
      },
    });

    // Si ya existe una fila exacta (activa o revocada), reactivarla
    const existing = await this.prisma.user_roles.findFirst({
      where: {
        profile_id: userId,
        module: module as never,
        role: role as never,
      },
      select: { id: true, is_active: true },
    });

    if (existing) {
      if (existing.is_active) {
        return this.prisma.user_roles.findUnique({ where: { id: existing.id } });
      }
      return this.prisma.user_roles.update({
        where: { id: existing.id },
        data: {
          is_active: true,
          revoked_at: null,
          revoked_by: null,
          granted_by: grantedBy,
          granted_at: new Date(),
        },
      });
    }

    return this.prisma.user_roles.create({
      data: {
        profile_id: userId,
        module: module as never,
        role: role as never,
        granted_by: grantedBy,
      },
    });
  }

  async revokeUserRole(
    roleId: string,
    revokedBy: string,
    allowedModules?: string[],
    allowedRoles?: string[],
  ) {
    if (allowedModules || allowedRoles) {
      const existing = await this.prisma.user_roles.findUnique({
        where: { id: roleId },
        select: { module: true, role: true },
      });
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

    try {
      return await this.prisma.user_roles.update({
        where: { id: roleId },
        data: {
          is_active: false,
          revoked_at: new Date(),
          revoked_by: revokedBy,
        },
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2025') {
        throw new NotFoundException('Asignación de rol no encontrada');
      }
      throw err;
    }
  }

  /** Get team members for a department (jefe_area use case) */
  async getMyTeam(departmentId: string, excludeUserId?: string) {
    return this.prisma.profiles.findMany({
      where: {
        department_id: departmentId,
        is_active: true,
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      },
      include: { departments: { select: { id: true, name: true } } },
      orderBy: { full_name: 'asc' },
    });
  }
}
