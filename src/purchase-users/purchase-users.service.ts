import { Injectable } from '@nestjs/common';
import { Prisma, user_role } from '@prisma/client';
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

/**
 * G4 (junta 2026-09-28) — Búsqueda de personas sin acentos, sin importar
 * mayúsculas y por palabras en cualquier orden ("jorge gonzalez" encuentra a
 * "Jorge Alberto González"). Sin la extensión `unaccent` (no está instalada):
 * el término se pliega aquí en TS y las columnas en SQL con
 * `translate(lower(x), …)` usando el MISMO mapa.
 */
const ACCENTED = 'áàäâãéèëêíìïîóòöôõúùüûñç';
const UNACCENTED = 'aaaaaeeeeiiiiooooouuuunc';

/**
 * Mapa del `translate` en SQL. Lleva también las mayúsculas acentuadas: con
 * una BD en locale C, `lower()` de PostgreSQL solo baja ASCII.
 */
export const SQL_FOLD_FROM = ACCENTED + ACCENTED.toUpperCase();
export const SQL_FOLD_TO = UNACCENTED + UNACCENTED;

const FOLD = new Map([...ACCENTED].map((ch, i) => [ch, UNACCENTED[i]]));

/**
 * Término de búsqueda → palabras normalizadas: minúsculas, sin acentos (mismo
 * mapa que el SQL) y partidas en todo lo que no sea letra o número —
 * espacios y también `.`, `@`, `-`, `_`, `,` —, así "jorge.gonzalez@"
 * encuentra a "Jorge Alberto González <jgonzalez@…>". Sin repetidas. Vacío o
 * solo signos → [] (sin búsqueda).
 */
export function normalizeSearchTokens(term?: string | null): string[] {
  if (!term) return [];
  const folded = Array.from(
    term.normalize('NFC').toLowerCase(),
    (ch) => FOLD.get(ch) ?? ch,
  ).join('');
  const tokens = folded.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  return [...new Set(tokens)];
}

/** Escapa los comodines de LIKE (`\`, `%`, `_`) para buscar el texto tal cual. */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Columnas del listado de gestión de roles (mismo select con y sin búsqueda). */
const ROLE_MANAGEMENT_SELECT = {
  id: true,
  full_name: true,
  email: true,
  position: true,
  departments: { select: { name: true } },
  user_roles_user_roles_profile_idToprofiles: {
    where: { is_active: true, module: 'compras' },
    select: { role: true },
  },
} as const;

type RoleManagementRow = Prisma.profilesGetPayload<{
  select: typeof ROLE_MANAGEMENT_SELECT;
}>;

interface RoleManagementPage {
  total: number;
  rows: RoleManagementRow[];
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

  /**
   * Listado para el APARTADO de gestión de roles de Compras (autoservicio,
   * junta 2026-09-17): TODOS los perfiles activos del sistema — no solo los
   * que ya tienen rol de compras, porque el punto es poder asignárselo —
   * con sus roles de compras vigentes. Paginado con búsqueda por
   * nombre/email (G4: sin acentos y por palabras, ver normalizeSearchTokens).
   */
  async findAllForRoleManagement(page: number, limit: number, search?: string) {
    const tokens = normalizeSearchTokens(search);
    const { total, rows } =
      tokens.length > 0
        ? await this.searchForRoleManagement(tokens, page, limit)
        : await this.listForRoleManagement(page, limit);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      data: rows.map((row) => ({
        id: row.id,
        full_name: row.full_name,
        email: row.email,
        position: row.position,
        department: row.departments?.name ?? null,
        purchase_roles: row.user_roles_user_roles_profile_idToprofiles.map(
          (r) => r.role,
        ),
      })),
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  /** Sin término de búsqueda: el camino de Prisma de siempre. */
  private async listForRoleManagement(
    page: number,
    limit: number,
  ): Promise<RoleManagementPage> {
    const where = { is_active: true };
    const [total, rows] = await Promise.all([
      this.prisma.profiles.count({ where }),
      this.prisma.profiles.findMany({
        where,
        select: ROLE_MANAGEMENT_SELECT,
        orderBy: { full_name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { total, rows };
  }

  /**
   * Con término: un solo SQL parametrizado resuelve los ids de la página y el
   * total — cada palabra debe aparecer en el nombre O en el correo, ambos
   * plegados con translate(lower()) — y luego se leen esas filas con el
   * mismo select de Prisma, reordenadas al orden del SQL. El LEFT JOIN
   * contra el conteo garantiza una fila aunque la página salga vacía, así el
   * total es correcto también fuera de rango.
   */
  private async searchForRoleManagement(
    tokens: string[],
    page: number,
    limit: number,
  ): Promise<RoleManagementPage> {
    const everyToken = Prisma.join(
      tokens.map((token) => {
        const pattern = `%${escapeLikePattern(token)}%`;
        return Prisma.sql`(f.name_key LIKE ${pattern} ESCAPE '\\' OR f.email_key LIKE ${pattern} ESCAPE '\\')`;
      }),
      ' AND ',
    );
    const hits = await this.prisma.$queryRaw<
      Array<{ id: string | null; total: number }>
    >(Prisma.sql`
      WITH matches AS (
        SELECT f.id, f.full_name, f.email
        FROM (
          SELECT p.id, p.full_name, p.email,
            translate(lower(coalesce(p.full_name, '')), ${SQL_FOLD_FROM}, ${SQL_FOLD_TO}) AS name_key,
            translate(lower(p.email), ${SQL_FOLD_FROM}, ${SQL_FOLD_TO}) AS email_key
          FROM profiles p
          WHERE p.is_active = true
        ) f
        WHERE ${everyToken}
      ),
      paged AS (
        SELECT id, full_name, email FROM matches
        ORDER BY full_name NULLS LAST, email
        LIMIT ${limit} OFFSET ${(page - 1) * limit}
      )
      SELECT pg.id::text AS id, t.total
      FROM (SELECT count(*)::int AS total FROM matches) t
      LEFT JOIN paged pg ON true
      ORDER BY pg.full_name NULLS LAST, pg.email`);

    const total = hits[0]?.total ?? 0;
    const ids = hits.flatMap((hit) => (hit.id ? [hit.id] : []));
    if (ids.length === 0) return { total, rows: [] };

    const rows = await this.prisma.profiles.findMany({
      where: { id: { in: ids } },
      select: ROLE_MANAGEMENT_SELECT,
    });
    const position = new Map(ids.map((id, index) => [id, index]));
    rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
    return { total, rows };
  }
}
