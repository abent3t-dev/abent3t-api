import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Helper compartido para mantener consistente el sistema de roles multi-módulo:
 *  - profiles.role  → rol primario (legado, módulo principal del usuario)
 *  - user_roles     → tabla unión (profile_id, module, role) que soporta
 *                     varios roles del mismo usuario en distintos módulos.
 *
 * Cualquier alta/cambio de rol primario debe pasar por aquí para mantener
 * ambas fuentes sincronizadas.
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
 *
 * Regla: super_admin manda. Después roles de dirección/admin. Después
 * roles operativos por módulo. Por último colaborador/empleado.
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
 *
 * No falla si la tabla user_roles aún no existe (degrada silenciosamente).
 */
export async function upsertUserRole(
  supabase: SupabaseClient,
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

  try {
    const { data: existing } = await supabase
      .from('user_roles')
      .select('id, is_active')
      .eq('profile_id', params.profileId)
      .eq('module', module)
      .eq('role', params.role)
      .maybeSingle();

    if (existing) {
      if (existing.is_active) return;
      await supabase
        .from('user_roles')
        .update({
          is_active: true,
          revoked_at: null,
          revoked_by: null,
          granted_by: params.grantedBy ?? null,
          granted_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
      return;
    }

    await supabase.from('user_roles').insert({
      profile_id: params.profileId,
      module,
      role: params.role,
      granted_by: params.grantedBy ?? null,
    });
  } catch {
    // Tabla aún no existe (entornos pre-migración 015) — ignorar silenciosamente.
  }
}

/**
 * Revoca todas las entradas activas (profile_id, module, role) que
 * correspondan al rol dado. Útil para sincronizar un cambio de rol primario.
 */
export async function revokeUserRole(
  supabase: SupabaseClient,
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

  try {
    await supabase
      .from('user_roles')
      .update({
        is_active: false,
        revoked_at: new Date().toISOString(),
        revoked_by: params.revokedBy ?? null,
      })
      .eq('profile_id', params.profileId)
      .eq('module', module)
      .eq('role', params.role)
      .eq('is_active', true);
  } catch {
    // Ignorar si la tabla no existe
  }
}
