import {
  CrehanaCourse,
  CrehanaUser,
  CrehanaCourseProgress,
  CrehanaProgress,
} from './crehana.types';

/**
 * Mapper para convertir datos de Crehana al formato interno de ABENT
 */
export class CrehanaMapper {
  /**
   * Convertir curso de Crehana a platform_courses
   */
  static toPlatformCourse(
    course: CrehanaCourse,
    integrationId: string,
  ): Record<string, unknown> {
    return {
      platform_integration_id: integrationId,
      external_course_id: course.id,
      external_track_id: course.track_id || null,
      name: course.title,
      description: course.description || null,
      instructor: course.instructor || null,
      language: course.language || 'es',
      total_hours: course.duration_hours || 0,
      total_modules: course.modules_count || 0,
      total_lessons: course.lessons_count || 0,
      course_url: course.course_url || null,
      thumbnail_url: course.thumbnail_url || null,
      is_active: true,
      last_synced_at: new Date().toISOString(),
    };
  }

  /**
   * Convertir usuario de Crehana a platform_user_mappings
   */
  static toUserMapping(
    user: CrehanaUser,
    integrationId: string,
    profileId: string,
  ): Record<string, unknown> {
    return {
      platform_integration_id: integrationId,
      profile_id: profileId,
      external_user_id: user.id,
      external_email: user.email,
      external_username: user.username || null,
      is_active: user.is_active,
      last_synced_at: new Date().toISOString(),
    };
  }

  /**
   * Convertir progreso de curso a platform_enrollments
   */
  static toPlatformEnrollment(
    progress: CrehanaCourseProgress,
    platformCourseId: string,
    profileId: string,
    externalUserId: string,
  ): Record<string, unknown> {
    // Mapear estado de Crehana a nuestro enum
    const statusMap: Record<string, string> = {
      not_started: 'not_started',
      in_progress: 'in_progress',
      completed: 'completed',
    };

    return {
      platform_course_id: platformCourseId,
      profile_id: profileId,
      external_enrollment_id: `${externalUserId}_${progress.course_id}`,
      external_user_id: externalUserId,
      progress_percentage: progress.progress_percentage || 0,
      status: statusMap[progress.status] || 'not_started',
      enrolled_at: progress.started_at || null,
      started_at: progress.started_at || null,
      completed_at: progress.completed_at || null,
      last_activity_at: progress.last_activity_at || null,
      hours_completed: progress.hours_completed || 0,
      modules_completed: progress.modules_completed || 0,
      lessons_completed: progress.lessons_completed || 0,
      certificate_url: progress.certificate_url || null,
      certificate_issued_at: progress.completed_at || null,
      last_synced_at: new Date().toISOString(),
      is_active: true,
    };
  }

  /**
   * Convertir datos de perfil interno a formato de registro en Crehana
   */
  static toRegisterUserDto(profile: {
    email: string;
    full_name?: string;
  }): Record<string, string> {
    const nameParts = (profile.full_name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    return {
      email: profile.email,
      first_name: firstName,
      last_name: lastName,
      username: profile.email.split('@')[0],
    };
  }

  /**
   * Calcular estadísticas de progreso
   */
  static calculateProgressStats(enrollments: CrehanaCourseProgress[]): {
    total_courses: number;
    completed_courses: number;
    in_progress_courses: number;
    total_hours_completed: number;
    average_progress: number;
  } {
    const stats = {
      total_courses: enrollments.length,
      completed_courses: 0,
      in_progress_courses: 0,
      total_hours_completed: 0,
      average_progress: 0,
    };

    let totalProgress = 0;

    for (const enrollment of enrollments) {
      if (enrollment.status === 'completed') {
        stats.completed_courses++;
      } else if (enrollment.status === 'in_progress') {
        stats.in_progress_courses++;
      }

      stats.total_hours_completed += enrollment.hours_completed || 0;
      totalProgress += enrollment.progress_percentage || 0;
    }

    stats.average_progress =
      enrollments.length > 0
        ? Math.round(totalProgress / enrollments.length)
        : 0;

    return stats;
  }
}
