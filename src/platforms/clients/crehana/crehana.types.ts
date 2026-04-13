/**
 * Tipos de respuesta de la API de Crehana
 * Basados en la documentación disponible:
 * https://ayuda.crehana.com/es/articles/6540231-como-integrarse-con-crehana
 */

// =====================================================
// ORGANIZACIÓN
// =====================================================

export interface CrehanaOrganization {
  id: string;
  name: string;
  tracks: CrehanaTrack[];
  total_users: number;
  total_courses: number;
}

// =====================================================
// RUTAS DE APRENDIZAJE (TRACKS)
// =====================================================

export interface CrehanaTrack {
  id: string;
  name: string;
  description?: string;
  courses: CrehanaCourse[];
  total_hours: number;
  total_courses: number;
}

// =====================================================
// CURSOS
// =====================================================

export interface CrehanaCourse {
  id: string;
  title: string;
  description?: string;
  instructor?: string;
  language: string;
  duration_hours: number;
  modules_count: number;
  lessons_count: number;
  thumbnail_url?: string;
  course_url?: string;
  track_id?: string;
}

// =====================================================
// USUARIOS
// =====================================================

export interface CrehanaUser {
  id: string;
  email: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  is_active: boolean;
  created_at?: string;
  assigned_courses?: string[]; // IDs de cursos asignados
}

export interface CrehanaRegisterUserDto {
  email: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface CrehanaUpdateUserDto {
  email?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

// =====================================================
// PROGRESO
// =====================================================

export interface CrehanaProgress {
  user_id: string;
  user_email: string;
  courses: CrehanaCourseProgress[];
}

export interface CrehanaCourseProgress {
  course_id: string;
  course_title: string;
  progress_percentage: number;
  status: 'not_started' | 'in_progress' | 'completed';
  started_at?: string;
  completed_at?: string;
  last_activity_at?: string;
  hours_completed?: number;
  modules_completed?: number;
  lessons_completed?: number;
  certificate_url?: string;
}

// =====================================================
// RESPUESTAS DE API
// =====================================================

export interface CrehanaApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  errors?: string[];
}

export interface CrehanaPaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    total: number;
    page: number;
    per_page: number;
    total_pages: number;
  };
}

// =====================================================
// CONFIGURACIÓN
// =====================================================

export interface CrehanaConfig {
  api_url: string;
  public_key: string;
  private_key: string;
}
