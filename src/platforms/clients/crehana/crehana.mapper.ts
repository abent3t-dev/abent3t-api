import {
  CrehanaCatalogContent,
  CrehanaGeneralReportRow,
  CrehanaUserOrganization,
} from './crehana.types';

/**
 * Transformaciones desde los schemas reales de Crehana v5
 * hacia el formato de las tablas internas de ABENT.
 *
 * Sólo lectura: ABENT consume estos datos para mostrarlos.
 */
export class CrehanaMapper {
  /**
   * Curso (a partir de una fila del reporte general).
   * Usamos el reporte como fuente porque sólo nos interesan los cursos
   * donde hay colaboradores inscritos.
   */
  static courseFromReportRow(
    row: CrehanaGeneralReportRow,
    integrationId: string,
  ): Record<string, unknown> {
    return {
      platform_integration_id: integrationId,
      external_course_id: row.course_id,
      external_track_id: row.track_id ?? null,
      name: row.course_name,
      description: null,
      instructor: null,
      language: 'es',
      total_hours: Number(row.course_duration_hours) || 0,
      total_modules: 0,
      total_lessons: 0,
      course_url: null,
      thumbnail_url: null,
      is_active: true,
      last_synced_at: new Date().toISOString(),
    };
  }

  /**
   * Curso (a partir de un nodo del catálogo).
   * Disponible si en algún momento se decide enriquecer con descripción/módulos.
   */
  static courseFromCatalogNode(
    node: CrehanaCatalogContent,
    integrationId: string,
  ): Record<string, unknown> {
    const course = node.course;
    const totalLessons = course.modules.reduce(
      (acc, m) => acc + (m.videos?.length ?? 0),
      0,
    );
    return {
      platform_integration_id: integrationId,
      external_course_id: course.id,
      external_track_id: null,
      name: course.title,
      description: course.description ?? null,
      instructor: null,
      language: 'es',
      total_hours: 0,
      total_modules: course.modules.length,
      total_lessons: totalLessons,
      course_url: node.learning_absolute_url ?? node.learning_url ?? null,
      thumbnail_url: course.image_url ?? course.image ?? null,
      is_active: true,
      last_synced_at: new Date().toISOString(),
    };
  }

  /**
   * Mapeo de usuario Crehana → ABENT. profileId es null si no hay match por email.
   */
  static userMapping(
    user: CrehanaUserOrganization,
    integrationId: string,
    profileId: string | null,
  ): Record<string, unknown> {
    return {
      platform_integration_id: integrationId,
      profile_id: profileId,
      external_user_id: user.user.id,
      external_email: user.user.email,
      external_username:
        [user.user.first_name, user.user.last_name].filter(Boolean).join(' ').trim() || null,
      is_active: user.status !== 'INACTIVE',
      last_synced_at: new Date().toISOString(),
    };
  }

  /**
   * Inscripción / progreso (desde una fila del reporte general).
   * platformCourseId es el ID interno de ABENT (UUID), no el de Crehana.
   * profileId es null si no hay match por email.
   */
  static enrollmentFromReportRow(
    row: CrehanaGeneralReportRow,
    platformCourseId: string,
    profileId: string | null,
  ): Record<string, unknown> {
    let status: 'not_started' | 'in_progress' | 'completed' = 'not_started';
    if (row.course_is_completed) {
      status = 'completed';
    } else if (Number(row.course_progress) > 0) {
      status = 'in_progress';
    }

    return {
      platform_course_id: platformCourseId,
      profile_id: profileId,
      external_enrollment_id: `${row.user_id}_${row.course_id}`,
      external_user_id: row.user_id,
      external_user_email: row.user_email ?? null,
      progress_percentage: Number(row.course_progress) || 0,
      status,
      enrolled_at: row.course_enroll_date ?? null,
      started_at: row.course_start_date ?? null,
      completed_at: row.course_complete_date ?? null,
      last_activity_at: row.course_last_action_date ?? null,
      hours_completed: Number(row.course_progress_hours) || 0,
      modules_completed: 0,
      lessons_completed: 0,
      certificate_url: row.course_certificated_url ?? null,
      certificate_issued_at: row.course_certificated_date ?? null,
      last_synced_at: new Date().toISOString(),
      is_active: row.is_enroll_active,
    };
  }
}
