/**
 * Tipos de respuesta de la Crehana Centralized Public API v5.
 * Schemas capturados directamente desde llamadas reales contra el endpoint
 * `/api/v5/rest/org/{organization_slug}/...` el 2026-04-29.
 *
 * Doc oficial: https://www.crehana.com/api/v5/rest/redocs
 */

// =====================================================
// CONFIGURACIÓN
// =====================================================

export interface CrehanaConfig {
  /** Base URL: típicamente https://www.crehana.com/api/v5/rest */
  api_url: string;
  /** Slug de la organización: se inserta en cada path: /org/{slug}/... */
  organization_slug: string;
  /** Header `api-key` */
  api_key: string;
  /** Header `secret-access` (atención: NO `secret-key` como dice la doc) */
  secret_access: string;
}

// =====================================================
// PAGINACIÓN
// =====================================================

/**
 * Paginación por offset/limit usada en users y reports.
 * Forma de la respuesta: { total, results[] }
 */
export interface CrehanaOffsetPaginated<T> {
  total: number;
  results: T[];
}

/**
 * Paginación tipo Relay (cursor) usada en los catálogos de cursos.
 * Forma de la respuesta: { total_count, page_info, edges[].node }
 */
export interface CrehanaCursorPaginated<T> {
  total_count: number;
  page_info: {
    start_cursor: string | null;
    has_next_page: boolean;
    has_previous_page: boolean;
    end_cursor: string | null;
  };
  edges: Array<{ node: T }>;
}

// =====================================================
// USUARIOS — `/users/user-organizations/`
// =====================================================

export interface CrehanaUserOrganization {
  /** ID del registro user-organization */
  id: string;
  user: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
  };
  status: string;       // p.ej. "PENDING", "USER_ACTIVE"
  role: string;         // p.ej. "MEMBER", "Admin"
  document_type: string | null;
  document: string | null;
  civil_status: string | null;
  country_code: string | null;
  area: { id: string; label: string; name: string } | null;
  headquarter: { id: string; name: string } | null;
  position: { id: string; name: string } | null;
  position_category: { id: string; name: string } | null;
  incorporation_date: string | null;
  birthday_date: string | null;
  created_at: string;
  updated_at: string;
  /** ID del usuario en el módulo Learning. Puede ser null si nunca ha entrado a Crehana Learn. */
  learning_user_id: string | null;
  learning_user_organization_id: string | null;
  talent_employee_id: string | null;
  custom_fields: Array<{ id: number; value: string | null; choice_id: number | null }>;
}

// =====================================================
// CATÁLOGO DE CURSOS — `/learning/content/knowledge-hub/catalog/{elevate|crehana}/`
// =====================================================

export interface CrehanaCatalogVideo {
  id: string;
  title: string;
  order: number;
}

export interface CrehanaCatalogModule {
  id: string;
  name: string;
  order: number;
  videos: CrehanaCatalogVideo[];
}

export interface CrehanaCatalogCourse {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  image: string | null;
  image_url: string | null;
  modules: CrehanaCatalogModule[];
  course_level: { name: string } | null;
}

export interface CrehanaCatalogContent {
  course: CrehanaCatalogCourse;
  content_type: string; // p.ej. "CONTENT_TYPE_COURSE"
  content_path: string | null;
  content_url: string | null;
  absolute_url: string | null;
  learning_url: string | null;
  learning_absolute_url: string | null;
}

// =====================================================
// REPORTE GENERAL — `/reports/learning/general/`
// Una fila por (usuario, curso). Es la fuente de verdad para mostrar progreso.
// =====================================================

export interface CrehanaGeneralReportRow {
  user_id: string;
  user_name: string;
  user_email: string;
  user_status: string;
  user_info_extra: string | null;
  is_enroll_active: boolean;

  course_id: string;
  course_name: string;
  course_category: string | null;
  course_subcategory: string | null;
  is_admin_assigned: boolean;
  assigned_by_name: string | null;
  course_type: string;             // p.ej. "Librería Organización"
  course_is_reward: string;        // "YES" | "NO"
  course_duration_hours: number;
  course_progress: number;         // 0..100
  course_progress_hours: number;
  course_is_completed: boolean;

  project_status: string | null;
  project_date: string | null;
  quiz_status: string | null;
  quiz_attemps: number | null;
  quiz_best_correct_answers: number | null;
  quiz_best_wrong_answers: number | null;
  quiz_total_questions: number | null;
  quiz_best_result: number | null;

  course_is_certified: boolean;
  course_has_participation_certificate: boolean;

  course_enroll_date: string | null;
  course_start_date: string | null;
  course_complete_date: string | null;
  course_certificated_date: string | null;
  course_last_action_date: string | null;

  project_url: string | null;
  course_certificated_url: string | null;
  course_participation_certificate_url: string | null;

  user_division: string | null;
  user_subsidiary: string | null;
  user_job: string | null;
  user_level: string | null;
  user_role: string | null;

  track_id: string | null;
  track_name: string | null;
  track_is_hidden: boolean | null;

  user_custom_fields: Array<{ field_name: string; field_answer: string | null }>;
}

// =====================================================
// REPORTE PERFORMANCE — `/reports/learning/performance/`
// Una fila por usuario, agregando totales.
// =====================================================

export interface CrehanaPerformanceReportRow {
  user_id: string;
  user_name: string;
  user_email: string;
  user_division: string | null;
  user_subsidiary: string | null;
  user_job: string | null;
  user_level: string | null;
  user_role: string | null;
  user_status: string;
  user_info_extra: string | null;

  courses_total: number;
  courses_organization_total: number;
  courses_complete_total: number;
  courses_organization_complete_total: number;
  projects_total: number;
  quizzes_total: number;
  certificates_total: number;
  participation_certificates_total: number;
  progress_hours: number;
  played_hours: number;

  courses_complete_total_percentage: number; // 0..1
  courses_organization_complete_total_percentage: number;

  user_created_date: string | null;
  user_activated_date: string | null;
  last_action_date: string | null;

  tracks_total: number;
  tracks_complete_total: number;
  tracks_complete_total_percentage: number; // 0..1

  user_custom_fields: Array<{ field_name: string; field_answer: string | null }>;
}
