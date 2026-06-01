import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Helper compartido para mantener consistente el sistema de roles multi-módulo:
 *  - profiles.role  → rol primario (legado, módulo principal del usuario)
 *  - user_roles     → tabla unión (profile_id, module, role) que soporta
 *                     varios roles del mismo usuario en distintos módulos.
 *
 * Cualquier alta/cambio de rol primario debe pasar por aquí para mantener
 * ambas fuentes sincronizadas.
 *
 * Post-migración a Prisma: las funciones reciben `PrismaService` (antes
 * `SupabaseClient`). La semántica es idéntica.
 */

export type UserModule = 'core' | 'capacitacion' | 'compras' | 'contabilidad';

/**
 * Mapeo de rol → módulo. Refleja la categorización aplicada en la migración
 * 015_user_roles_multi_module.sql. Si se agregan roles nuevos a la BD,
 * agregarlos también aquí.
 */
export const ROLE_TO_MODULE: Record<string, UserModule> = {
  // Core (transversales)
  super_admin: 'core',
  executive: 'core',

  // Capacitación
  admin_rh: 'capacitacion',
  jefe_area: 'capacitacion',
  director: 'capacitacion',
  colaborador: 'capacitacion',
  collaborator: 'capacitacion',

  // Compras
  comprador: 'compras',
  coordinador_compras: 'compras',
  lider_procura: 'compras',
  aprobador_nivel_1: 'compras',
  aprobador_nivel_2: 'compras',
  aprobador_nivel_3: 'compras',
  director_general: 'compras',
  solicitante: 'compras',

  // Contabilidad
  contabilidad: 'contabilidad',
  fiscal: 'contabilidad',
  director_financiero: 'contabilidad',
  accionista: 'contabilidad',
};

/** Devuelve el módulo correspondiente a un rol, o null si es desconocido. */
export function getModuleForRole(role: string | null | undefined): UserModule | null {
  if (!role) return null;
  return ROLE_TO_MODULE[role] ?? null;
}

/**
 * Prioridad de roles para "elegir uno como representativo del usuario".
 *
 * Ordenado de mayor a menor importancia. Se usa para:
 *  - HOME_ROUTES post-login (a qué pantalla redirigir)
 *  - Display de un solo badge cuando el usuario tiene varios roles
 */
export const ROLE_PRIORITY: string[] = [
  'super_admin',
  'director_general',
  'director_financiero',
  'lider_procura',
  'admin_rh',
  'director',
  'coordinador_compras',
  'accionista',
  'fiscal',
  'contabilidad',
  'jefe_area',
  'aprobador_nivel_3',
  'aprobador_nivel_2',
  'aprobador_nivel_1',
  'comprador',
  'solicitante',
  'executive',
  'colaborador',
  'collaborator',
];

/**
 * Dado el conjunto de roles activos de un usuario, devuelve el "rol principal"
 * para fines de display y redirección. Si el usuario no tiene ningún rol
 * conocido, devuelve null (la UI debe manejar ese caso edge).
 */
export function getDisplayRole(roles: string[] | undefined | null): string | null {
  if (!roles || roles.length === 0) return null;
  const set = new Set(roles);
  for (const r of ROLE_PRIORITY) {
    if (set.has(r)) return r;
  }
  return roles[0]; // fallback: primero del array si ninguno está en la prioridad
}

/**
 * Asigna (o reactiva) una entrada (profile_id, module, role) en user_roles.
 * Idempotente: si ya estaba activa, no hace nada; si estaba revocada, la
 * reactiva con nuevo granted_by/granted_at; si no existía, la crea.
 */
export async function upsertUserRole(
  prisma: PrismaService,
  params: {
    profileId: string;
    role: string;
    grantedBy?: string | null;
    /** Si se omite, se infiere de ROLE_TO_MODULE. */
    module?: UserModule;
  },
): Promise<void> {
  const module = params.module ?? getModuleForRole(params.role);
  if (!module) return; // rol desconocido — no hacemos nada

  const existing = await prisma.user_roles.findFirst({
    where: {
      profile_id: params.profileId,
      module,
      role: params.role as never,
    },
    select: { id: true, is_active: true },
  });

  if (existing) {
    if (existing.is_active) return;
    await prisma.user_roles.update({
      where: { id: existing.id },
      data: {
        is_active: true,
        revoked_at: null,
        revoked_by: null,
        granted_by: params.grantedBy ?? null,
        granted_at: new Date(),
      },
    });
    return;
  }

  await prisma.user_roles.create({
    data: {
      profile_id: params.profileId,
      module,
      role: params.role as never,
      granted_by: params.grantedBy ?? null,
    },
  });
}

/**
 * Revoca todas las entradas activas (profile_id, module, role) que
 * correspondan al rol dado. Útil para sincronizar un cambio de rol primario.
 */
export async function revokeUserRole(
  prisma: PrismaService,
  params: {
    profileId: string;
    role: string;
    revokedBy?: string | null;
    /** Si se omite, se infiere. */
    module?: UserModule;
  },
): Promise<void> {
  const module = params.module ?? getModuleForRole(params.role);
  if (!module) return;

  await prisma.user_roles.updateMany({
    where: {
      profile_id: params.profileId,
      module,
      role: params.role as never,
      is_active: true,
    },
    data: {
      is_active: false,
      revoked_at: new Date(),
      revoked_by: params.revokedBy ?? null,
    },
  });
}
