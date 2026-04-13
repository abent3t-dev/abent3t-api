import { Injectable, Logger } from '@nestjs/common';
import {
  CrehanaConfig,
  CrehanaOrganization,
  CrehanaUser,
  CrehanaRegisterUserDto,
  CrehanaUpdateUserDto,
  CrehanaProgress,
  CrehanaCourse,
  CrehanaTrack,
  CrehanaApiResponse,
} from './crehana.types';

/**
 * Cliente HTTP para la API de Crehana
 *
 * Documentación:
 * - https://ayuda.crehana.com/es/articles/6540231-como-integrarse-con-crehana
 *
 * Endpoints conocidos:
 * - Información de organización
 * - Registro de usuarios
 * - Inscripción en tracks
 * - Actualización de usuarios
 * - Progreso de usuarios
 */
@Injectable()
export class CrehanaClient {
  private readonly logger = new Logger(CrehanaClient.name);

  private config: CrehanaConfig | null = null;

  /**
   * Configurar el cliente con las credenciales
   */
  configure(config: CrehanaConfig): void {
    this.config = config;
    this.logger.log(`Crehana client configured for: ${config.api_url}`);
  }

  /**
   * Verificar que el cliente está configurado
   */
  private ensureConfigured(): void {
    if (!this.config) {
      throw new Error('Crehana client not configured. Call configure() first.');
    }
  }

  /**
   * Construir headers de autenticación
   */
  private getHeaders(): Record<string, string> {
    this.ensureConfigured();
    return {
      'Content-Type': 'application/json',
      'X-Public-Key': this.config!.public_key,
      'X-Private-Key': this.config!.private_key,
      // O puede ser Authorization: Bearer <token>
      // Depende de la documentación específica de Crehana
    };
  }

  /**
   * Realizar petición HTTP a la API de Crehana
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    body?: unknown,
  ): Promise<T> {
    this.ensureConfigured();

    const url = `${this.config!.api_url}${endpoint}`;

    try {
      const response = await fetch(url, {
        method,
        headers: this.getHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Crehana API error: ${response.status} - ${errorText}`);
        throw new Error(`Crehana API error: ${response.status}`);
      }

      const data = await response.json();
      return data as T;
    } catch (error) {
      this.logger.error(`Crehana request failed: ${method} ${endpoint}`, error);
      throw error;
    }
  }

  // =====================================================
  // ORGANIZACIÓN
  // =====================================================

  /**
   * Obtener información de la organización
   * Incluye rutas de aprendizaje y cursos
   */
  async getOrganizationInfo(): Promise<CrehanaApiResponse<CrehanaOrganization>> {
    return this.request<CrehanaApiResponse<CrehanaOrganization>>(
      'GET',
      '/organization',
    );
  }

  // =====================================================
  // USUARIOS
  // =====================================================

  /**
   * Listar todos los usuarios de la organización
   */
  async listUsers(): Promise<CrehanaApiResponse<CrehanaUser[]>> {
    return this.request<CrehanaApiResponse<CrehanaUser[]>>(
      'GET',
      '/users',
    );
  }

  /**
   * Obtener información de un usuario específico
   */
  async getUser(userId: string): Promise<CrehanaApiResponse<CrehanaUser>> {
    return this.request<CrehanaApiResponse<CrehanaUser>>(
      'GET',
      `/users/${userId}`,
    );
  }

  /**
   * Registrar un nuevo usuario en Crehana
   */
  async registerUser(data: CrehanaRegisterUserDto): Promise<CrehanaApiResponse<CrehanaUser>> {
    return this.request<CrehanaApiResponse<CrehanaUser>>(
      'POST',
      '/users',
      data,
    );
  }

  /**
   * Actualizar información de un usuario
   */
  async updateUser(userId: string, data: CrehanaUpdateUserDto): Promise<CrehanaApiResponse<CrehanaUser>> {
    return this.request<CrehanaApiResponse<CrehanaUser>>(
      'PUT',
      `/users/${userId}`,
      data,
    );
  }

  /**
   * Eliminar/desactivar un usuario de la organización
   */
  async removeUser(userId: string): Promise<CrehanaApiResponse<void>> {
    return this.request<CrehanaApiResponse<void>>(
      'DELETE',
      `/users/${userId}`,
    );
  }

  // =====================================================
  // CURSOS Y RUTAS
  // =====================================================

  /**
   * Obtener catálogo de cursos disponibles
   */
  async getCourses(): Promise<CrehanaApiResponse<CrehanaCourse[]>> {
    return this.request<CrehanaApiResponse<CrehanaCourse[]>>(
      'GET',
      '/courses',
    );
  }

  /**
   * Obtener rutas de aprendizaje (tracks)
   */
  async getTracks(): Promise<CrehanaApiResponse<CrehanaTrack[]>> {
    return this.request<CrehanaApiResponse<CrehanaTrack[]>>(
      'GET',
      '/tracks',
    );
  }

  /**
   * Obtener cursos asignados a un usuario
   */
  async getUserCourses(userId: string): Promise<CrehanaApiResponse<CrehanaCourse[]>> {
    return this.request<CrehanaApiResponse<CrehanaCourse[]>>(
      'GET',
      `/users/${userId}/courses`,
    );
  }

  /**
   * Inscribir usuario en un track/ruta de aprendizaje
   */
  async enrollUserInTrack(userId: string, trackId: string): Promise<CrehanaApiResponse<void>> {
    return this.request<CrehanaApiResponse<void>>(
      'POST',
      `/users/${userId}/tracks/${trackId}/enroll`,
    );
  }

  /**
   * Asignar curso a un usuario
   */
  async assignCourseToUser(userId: string, courseId: string): Promise<CrehanaApiResponse<void>> {
    return this.request<CrehanaApiResponse<void>>(
      'POST',
      `/users/${userId}/courses/${courseId}/assign`,
    );
  }

  // =====================================================
  // PROGRESO
  // =====================================================

  /**
   * Obtener progreso de todos los usuarios
   */
  async getAllUsersProgress(): Promise<CrehanaApiResponse<CrehanaProgress[]>> {
    return this.request<CrehanaApiResponse<CrehanaProgress[]>>(
      'GET',
      '/progress',
    );
  }

  /**
   * Obtener progreso de un usuario específico
   */
  async getUserProgress(userId: string): Promise<CrehanaApiResponse<CrehanaProgress>> {
    return this.request<CrehanaApiResponse<CrehanaProgress>>(
      'GET',
      `/users/${userId}/progress`,
    );
  }

  // =====================================================
  // UTILIDADES
  // =====================================================

  /**
   * Verificar conexión con la API
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.getOrganizationInfo();
      return response.success;
    } catch {
      return false;
    }
  }
}
