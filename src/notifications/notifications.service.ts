import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

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
    const sinceDate = new Date(since || '1970-01-01T00:00:00Z');

    try {
      if (HR_ADMIN_ROLES.includes(role)) {
        return await this.prisma.training_requests.count({
          where: {
            status: 'pendiente',
            is_active: true,
            created_at: { gt: sinceDate },
          },
        });
      }

      if (MANAGER_ROLES.includes(role)) {
        return await this.prisma.training_requests.count({
          where: {
            requested_by: userId,
            status: { in: ['aprobada', 'rechazada'] },
            is_active: true,
            reviewed_at: { gt: sinceDate },
          },
        });
      }

      return 0;
    } catch {
      return 0;
    }
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
    const sinceDate = new Date(since || '1970-01-01T00:00:00Z');

    try {
      if (HR_ADMIN_ROLES.includes(role)) {
        return await this.prisma.course_proposals.count({
          where: {
            status: { in: ['pendiente', 'en_investigacion'] },
            is_active: true,
            created_at: { gt: sinceDate },
          },
        });
      }

      if (MANAGER_ROLES.includes(role) && departmentId) {
        const profiles = await this.prisma.profiles.findMany({
          where: { department_id: departmentId, is_active: true },
          select: { id: true },
        });

        const ids = profiles.map((p) => p.id);
        if (ids.length === 0) return 0;

        return await this.prisma.course_proposals.count({
          where: {
            OR: [
              { proposed_by: { in: ids } },
              { profile_id: { in: ids } },
            ],
            status: { in: ['aprobada', 'rechazada'] },
            is_active: true,
            reviewed_at: { gt: sinceDate },
          },
        });
      }

      if (EMPLOYEE_ROLES.includes(role)) {
        return await this.prisma.course_proposals.count({
          where: {
            OR: [
              { proposed_by: userId },
              { profile_id: userId },
            ],
            status: { in: ['aprobada', 'rechazada', 'en_investigacion'] },
            is_active: true,
            reviewed_at: { gt: sinceDate },
          },
        });
      }

      return 0;
    } catch {
      return 0;
    }
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
    const sinceDate = new Date(since || '1970-01-01T00:00:00Z');

    try {
      return await this.prisma.enrollment_evidences.count({
        where: {
          verification_status: 'pending',
          is_active: true,
          uploaded_at: { gt: sinceDate },
        },
      });
    } catch {
      return 0;
    }
  }
}
