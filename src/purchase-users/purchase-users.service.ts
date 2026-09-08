import { Injectable } from '@nestjs/common';
import { user_role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Fase §16 (T7) — Directorio mínimo de usuarios de compras para poblar
 * selects (comprador/responsable/aprobador). Resuelve el 403 que daba
 * `GET /auth/users` a PURCHASE_TEAM sin tocar el módulo de auth.
 *
 * Devuelve SOLO { id, full_name, email, role }: nada de department, flags ni
 * asignaciones completas.
 */

export const PURCHASE_DIRECTORY_ROLES = [
  'lider_procura',
  'coordinador_compras',
  'comprador',
  'aprobador_nivel_1',
  'aprobador_nivel_2',
  'aprobador_nivel_3',
  'director_general',
] as const;

export type PurchaseDirectoryRole = (typeof PURCHASE_DIRECTORY_ROLES)[number];

export interface PurchaseUserView {
  id: string;
  full_name: string | null;
  email: string;
  role: PurchaseDirectoryRole;
}

@Injectable()
export class PurchaseUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(roleFilter?: string): Promise<PurchaseUserView[]> {
    const roles = roleFilter
      ? PURCHASE_DIRECTORY_ROLES.filter((r) => r === roleFilter)
      : [...PURCHASE_DIRECTORY_ROLES];
    if (roles.length === 0) return []; // rol desconocido → lista vacía

    const roleEnums = roles as unknown as user_role[];
    const rows = await this.prisma.profiles.findMany({
      where: {
        is_active: true,
        OR: [
          {
            user_roles_user_roles_profile_idToprofiles: {
              some: { is_active: true, role: { in: roleEnums } },
            },
          },
          // Compatibilidad con el rol primario legado (profiles.role)
          { role: { in: roleEnums } },
        ],
      },
      select: {
        id: true,
        full_name: true,
        email: true,
        role: true,
        user_roles_user_roles_profile_idToprofiles: {
          where: { is_active: true, role: { in: roleEnums } },
          select: { role: true },
        },
      },
      orderBy: { full_name: 'asc' },
    });

    return rows.map((row) => {
      const assigned = row.user_roles_user_roles_profile_idToprofiles[0]?.role;
      return {
        id: row.id,
        full_name: row.full_name,
        email: row.email,
        role: (assigned ?? row.role) as PurchaseDirectoryRole,
      };
    });
  }
}
