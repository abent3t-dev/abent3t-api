import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export interface SidebarCountsParams {
  since_solicitudes?: string;
  since_propuestas?: string;
  since_evidencias?: string;
}

export interface SidebarCounts {
  solicitudes: number;
  propuestas: number;
  evidencias: number;
}

const HR_ADMIN_ROLES = ['admin_rh', 'super_admin'];
const MANAGER_ROLES = ['jefe_area', 'director'];
const EMPLOYEE_ROLES = ['colaborador', 'collaborator'];

/**
 * Calcula el conteo de items "nuevos desde X" por sección, según el rol del
 * usuario. El frontend pasa el timestamp de la última visita a cada sección
 * y el backend devuelve cuántos items relevantes son posteriores.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly supabase: SupabaseService) {}

  async getSidebarCounts(
    userId: string,
    role: string,
    departmentId: string | null,
    since: SidebarCountsParams,
  ): Promise<SidebarCounts> {
    const [solicitudes, propuestas, evidencias] = await Promise.all([
      this.countSolicitudes(userId, role, departmentId, since.since_solicitudes),
      this.countPropuestas(userId, role, departmentId, since.since_propuestas),
      this.countEvidencias(role, since.since_evidencias),
    ]);

    return { solicitudes, propuestas, evidencias };
  }

  /**
   * Solicitudes nuevas a revisar:
   * - admin_rh: pendientes creadas después de `since`
   * - jefe_area/director: sus solicitudes que fueron revisadas (aprobadas/rechazadas) después de `since`
   * - resto: 0
   */
  private async countSolicitudes(
    userId: string,
    role: string,
    departmentId: string | null,
    since: string | undefined,
  ): Promise<number> {
    const sinceDate = since || '1970-01-01T00:00:00Z';

    if (HR_ADMIN_ROLES.includes(role)) {
      const { count, error } = await this.supabase.db
        .from('training_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pendiente')
        .eq('is_active', true)
        .gt('created_at', sinceDate);
      if (error) return 0;
      return count ?? 0;
    }

    if (MANAGER_ROLES.includes(role)) {
      const { count, error } = await this.supabase.db
        .from('training_requests')
        .select('id', { count: 'exact', head: true })
        .eq('requested_by', userId)
        .in('status', ['aprobada', 'rechazada'])
        .eq('is_active', true)
        .gt('reviewed_at', sinceDate);
      if (error) return 0;
      return count ?? 0;
    }

    return 0;
  }

  /**
   * Propuestas nuevas a revisar:
   * - admin_rh: pendientes/en_investigacion creadas después de `since`
   * - jefe_area/director: propuestas de su equipo (proponente o beneficiario en su depto)
   *   que fueron revisadas después de `since`
   * - colaborador: sus propias propuestas revisadas después de `since`
   */
  private async countPropuestas(
    userId: string,
    role: string,
    departmentId: string | null,
    since: string | undefined,
  ): Promise<number> {
    const sinceDate = since || '1970-01-01T00:00:00Z';

    if (HR_ADMIN_ROLES.includes(role)) {
      const { count, error } = await this.supabase.db
        .from('course_proposals')
        .select('id', { count: 'exact', head: true })
        .in('status', ['pendiente', 'en_investigacion'])
        .eq('is_active', true)
        .gt('created_at', sinceDate);
      if (error) return 0;
      return count ?? 0;
    }

    if (MANAGER_ROLES.includes(role) && departmentId) {
      const { data: profiles } = await this.supabase.db
        .from('profiles')
        .select('id')
        .eq('department_id', departmentId)
        .eq('is_active', true);

      const ids = (profiles || []).map((p) => p.id);
      if (ids.length === 0) return 0;
      const idsList = ids.join(',');

      const { count, error } = await this.supabase.db
        .from('course_proposals')
        .select('id', { count: 'exact', head: true })
        .or(`proposed_by.in.(${idsList}),profile_id.in.(${idsList})`)
        .in('status', ['aprobada', 'rechazada'])
        .eq('is_active', true)
        .gt('reviewed_at', sinceDate);
      if (error) return 0;
      return count ?? 0;
    }

    if (EMPLOYEE_ROLES.includes(role)) {
      const { count, error } = await this.supabase.db
        .from('course_proposals')
        .select('id', { count: 'exact', head: true })
        .or(`proposed_by.eq.${userId},profile_id.eq.${userId}`)
        .in('status', ['aprobada', 'rechazada', 'en_investigacion'])
        .eq('is_active', true)
        .gt('reviewed_at', sinceDate);
      if (error) return 0;
      return count ?? 0;
    }

    return 0;
  }

  /**
   * Evidencias nuevas a revisar:
   * - admin_rh: pendientes subidas después de `since`
   * - resto: 0 (la sección sólo es accesible a admin_rh)
   */
  private async countEvidencias(
    role: string,
    since: string | undefined,
  ): Promise<number> {
    if (!HR_ADMIN_ROLES.includes(role)) return 0;
    const sinceDate = since || '1970-01-01T00:00:00Z';

    const { count, error } = await this.supabase.db
      .from('enrollment_evidences')
      .select('id', { count: 'exact', head: true })
      .eq('verification_status', 'pending')
      .eq('is_active', true)
      .gt('uploaded_at', sinceDate);
    if (error) return 0;
    return count ?? 0;
  }
}
