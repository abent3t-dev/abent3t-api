import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateIntegrationDto, PlatformType } from './dto/create-integration.dto';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { SyncOptionsDto, SyncType } from './dto/sync-options.dto';
import * as crypto from 'crypto';

// Selects para queries
const INTEGRATION_SELECT = `
  *,
  institutions(id, name, type, platform_url, annual_cost)
`;

const COURSE_SELECT = `
  *,
  platform_integrations(id, platform_type, institutions(id, name)),
  course_types(id, name),
  modalities(id, name)
`;

const ENROLLMENT_SELECT = `
  *,
  platform_courses(
    id, name, external_course_id, total_hours,
    platform_integrations(id, platform_type, institutions(id, name))
  ),
  profiles(id, full_name, email, departments(id, name))
`;

@Injectable()
export class PlatformsService {
  private readonly logger = new Logger(PlatformsService.name);

  // Clave para encriptar/desencriptar (en producción usar variable de entorno)
  private readonly ENCRYPTION_KEY = process.env.PLATFORM_ENCRYPTION_KEY || 'default-key-change-in-production-32';
  private readonly ENCRYPTION_IV_LENGTH = 16;

  constructor(private readonly supabase: SupabaseService) {}

  // =====================================================
  // CRUD DE INTEGRACIONES
  // =====================================================

  async findAllIntegrations() {
    const { data, error } = await this.supabase.db
      .from('platform_integrations')
      .select(INTEGRATION_SELECT)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // No devolver la clave privada
    return data?.map(this.sanitizeIntegration) ?? [];
  }

  async findIntegrationById(id: string) {
    const { data, error } = await this.supabase.db
      .from('platform_integrations')
      .select(INTEGRATION_SELECT)
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException('Integración no encontrada');
    }

    return this.sanitizeIntegration(data);
  }

  async findIntegrationByInstitution(institutionId: string) {
    const { data, error } = await this.supabase.db
      .from('platform_integrations')
      .select(INTEGRATION_SELECT)
      .eq('institution_id', institutionId)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return null;
    }

    return this.sanitizeIntegration(data);
  }

  async createIntegration(dto: CreateIntegrationDto, userId: string) {
    // Validar que la institución existe y es tipo 'platform'
    const { data: institution } = await this.supabase.db
      .from('institutions')
      .select('id, type, is_active')
      .eq('id', dto.institution_id)
      .single();

    if (!institution) {
      throw new BadRequestException('Institución no encontrada');
    }

    if (!institution.is_active) {
      throw new BadRequestException('La institución está desactivada');
    }

    if (institution.type !== 'platform') {
      throw new BadRequestException(
        'La institución debe ser de tipo "platform" para configurar integración API',
      );
    }

    // Verificar que no exista integración para esta institución
    const existing = await this.findIntegrationByInstitution(dto.institution_id);
    if (existing) {
      throw new ConflictException(
        'Ya existe una integración configurada para esta institución',
      );
    }

    // Encriptar la clave privada si se proporciona
    const insertData: Record<string, unknown> = {
      institution_id: dto.institution_id,
      platform_type: dto.platform_type,
      api_url: dto.api_url,
      public_key: dto.public_key,
      sync_enabled: dto.sync_enabled ?? true,
      sync_frequency_hours: dto.sync_frequency_hours ?? 24,
      sso_enabled: dto.sso_enabled ?? false,
      sso_type: dto.sso_type,
      sso_config: dto.sso_config,
      configured_by: userId,
    };

    if (dto.private_key) {
      insertData.private_key_encrypted = this.encryptKey(dto.private_key);
    }

    const { data, error } = await this.supabase.db
      .from('platform_integrations')
      .insert(insertData)
      .select(INTEGRATION_SELECT)
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('Ya existe una integración para esta institución');
      }
      throw error;
    }

    this.logger.log(`Integration created for institution ${dto.institution_id}`);
    return this.sanitizeIntegration(data);
  }

  async updateIntegration(id: string, dto: UpdateIntegrationDto) {
    // Verificar que existe
    await this.findIntegrationById(id);

    const updateData: Record<string, unknown> = { ...dto };

    // Encriptar nueva clave privada si se proporciona
    if ('private_key' in dto && dto.private_key) {
      updateData.private_key_encrypted = this.encryptKey(dto.private_key);
      delete updateData.private_key;
    }

    // No permitir cambiar institution_id
    delete updateData.institution_id;

    const { data, error } = await this.supabase.db
      .from('platform_integrations')
      .update(updateData)
      .eq('id', id)
      .select(INTEGRATION_SELECT)
      .single();

    if (error) throw error;

    this.logger.log(`Integration ${id} updated`);
    return this.sanitizeIntegration(data);
  }

  async removeIntegration(id: string) {
    const { error } = await this.supabase.db
      .from('platform_integrations')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;

    this.logger.log(`Integration ${id} deactivated`);
    return { message: 'Integración desactivada correctamente' };
  }

  // =====================================================
  // TEST DE CONEXIÓN
  // =====================================================

  async testConnection(id: string): Promise<{ success: boolean; message: string; details?: unknown }> {
    const integration = await this.getIntegrationWithCredentials(id);

    if (!integration.api_url || !integration.public_key) {
      return {
        success: false,
        message: 'Faltan credenciales de API (URL o clave pública)',
      };
    }

    try {
      // Según el tipo de plataforma, usar el cliente correspondiente
      switch (integration.platform_type) {
        case PlatformType.CREHANA:
          return await this.testCrehanaConnection(integration);
        default:
          return {
            success: false,
            message: `Cliente no implementado para plataforma: ${integration.platform_type}`,
          };
      }
    } catch (error) {
      this.logger.error(`Connection test failed for integration ${id}`, error);
      return {
        success: false,
        message: 'Error al conectar con la plataforma',
        details: error instanceof Error ? error.message : error,
      };
    }
  }

  private async testCrehanaConnection(integration: any): Promise<{ success: boolean; message: string; details?: unknown }> {
    // TODO: Implementar llamada real a API de Crehana
    // Por ahora, simular una conexión exitosa si hay credenciales

    const hasCredentials = integration.api_url && integration.public_key && integration.private_key_encrypted;

    if (!hasCredentials) {
      return {
        success: false,
        message: 'Credenciales incompletas para Crehana',
      };
    }

    // Simular llamada a endpoint de organización
    // En implementación real: await this.crehanaClient.getOrganizationInfo()

    return {
      success: true,
      message: 'Conexión exitosa con Crehana',
      details: {
        platform: 'Crehana',
        api_url: integration.api_url,
        // organization_name: response.name,
      },
    };
  }

  // =====================================================
  // CURSOS DE PLATAFORMA
  // =====================================================

  async findCoursesByIntegration(integrationId: string) {
    const { data, error } = await this.supabase.db
      .from('platform_courses')
      .select(COURSE_SELECT)
      .eq('platform_integration_id', integrationId)
      .eq('is_active', true)
      .order('name');

    if (error) throw error;
    return data ?? [];
  }

  async findAllPlatformCourses() {
    const { data, error } = await this.supabase.db
      .from('platform_courses')
      .select(COURSE_SELECT)
      .eq('is_active', true)
      .order('name');

    if (error) throw error;
    return data ?? [];
  }

  async findPlatformCourseById(courseId: string) {
    const { data, error } = await this.supabase.db
      .from('platform_courses')
      .select(COURSE_SELECT)
      .eq('id', courseId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Curso de plataforma no encontrado');
    }
    return data;
  }

  // =====================================================
  // INSCRIPCIONES/PROGRESO
  // =====================================================

  async findEnrollmentsByProfile(profileId: string) {
    const { data, error } = await this.supabase.db
      .from('platform_enrollments')
      .select(ENROLLMENT_SELECT)
      .eq('profile_id', profileId)
      .eq('is_active', true)
      .order('last_activity_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
  }

  async findEnrollmentsByDepartment(departmentId: string) {
    // Primero obtener perfiles del departamento
    const { data: profiles } = await this.supabase.db
      .from('profiles')
      .select('id')
      .eq('department_id', departmentId)
      .eq('is_active', true);

    if (!profiles || profiles.length === 0) return [];

    const profileIds = profiles.map((p) => p.id);

    const { data, error } = await this.supabase.db
      .from('platform_enrollments')
      .select(ENROLLMENT_SELECT)
      .in('profile_id', profileIds)
      .eq('is_active', true)
      .order('last_activity_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
  }

  async getEnrollmentsSummary() {
    // Resumen general de progreso en plataformas
    const { data: enrollments, error } = await this.supabase.db
      .from('platform_enrollments')
      .select(`
        id,
        status,
        progress_percentage,
        hours_completed,
        platform_courses(
          platform_integrations(platform_type)
        )
      `)
      .eq('is_active', true);

    if (error) throw error;

    const summary = {
      total_enrollments: enrollments?.length ?? 0,
      by_status: {
        not_started: 0,
        in_progress: 0,
        completed: 0,
        expired: 0,
      },
      total_hours_completed: 0,
      average_progress: 0,
      by_platform: {} as Record<string, number>,
    };

    if (enrollments) {
      let totalProgress = 0;

      for (const e of enrollments) {
        // Por estado
        summary.by_status[e.status as keyof typeof summary.by_status]++;

        // Horas totales
        summary.total_hours_completed += Number(e.hours_completed) || 0;

        // Progreso promedio
        totalProgress += Number(e.progress_percentage) || 0;

        // Por plataforma
        const platform = (e.platform_courses as any)?.platform_integrations?.platform_type;
        if (platform) {
          summary.by_platform[platform] = (summary.by_platform[platform] || 0) + 1;
        }
      }

      summary.average_progress = enrollments.length > 0
        ? Math.round(totalProgress / enrollments.length)
        : 0;
    }

    return summary;
  }

  // =====================================================
  // SINCRONIZACIÓN
  // =====================================================

  async triggerSync(integrationId: string, options: SyncOptionsDto, userId?: string) {
    const integration = await this.getIntegrationWithCredentials(integrationId);

    if (!integration.sync_enabled) {
      throw new BadRequestException('La sincronización está deshabilitada para esta integración');
    }

    // Crear log de sincronización
    const { data: syncLog, error: logError } = await this.supabase.db
      .from('platform_sync_logs')
      .insert({
        platform_integration_id: integrationId,
        sync_type: options.sync_type || SyncType.FULL,
        status: 'in_progress',
        triggered_by: userId,
      })
      .select()
      .single();

    if (logError) throw logError;

    try {
      // Ejecutar sincronización según tipo de plataforma
      let result;

      switch (integration.platform_type) {
        case PlatformType.CREHANA:
          result = await this.syncCrehana(integration, options.sync_type || SyncType.FULL);
          break;
        default:
          throw new BadRequestException(`Sincronización no implementada para: ${integration.platform_type}`);
      }

      // Actualizar log con resultado exitoso
      await this.supabase.db
        .from('platform_sync_logs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          courses_synced: result.courses_synced,
          enrollments_synced: result.enrollments_synced,
          users_synced: result.users_synced,
          sync_summary: result.summary,
        })
        .eq('id', syncLog.id);

      // Actualizar integración
      await this.supabase.db
        .from('platform_integrations')
        .update({
          last_sync_at: new Date().toISOString(),
          last_sync_status: 'completed',
          last_sync_error: null,
        })
        .eq('id', integrationId);

      return {
        success: true,
        sync_log_id: syncLog.id,
        ...result,
      };
    } catch (error) {
      // Actualizar log con error
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';

      await this.supabase.db
        .from('platform_sync_logs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          errors_count: 1,
          error_details: { message: errorMessage },
        })
        .eq('id', syncLog.id);

      // Actualizar integración con error
      await this.supabase.db
        .from('platform_integrations')
        .update({
          last_sync_at: new Date().toISOString(),
          last_sync_status: 'failed',
          last_sync_error: errorMessage,
        })
        .eq('id', integrationId);

      throw error;
    }
  }

  private async syncCrehana(integration: any, syncType: SyncType) {
    // TODO: Implementar sincronización real con Crehana
    // Por ahora retornar datos simulados

    this.logger.log(`Starting Crehana sync (${syncType}) for integration ${integration.id}`);

    // Simular sincronización
    const result = {
      courses_synced: 0,
      enrollments_synced: 0,
      users_synced: 0,
      summary: {
        sync_type: syncType,
        started_at: new Date().toISOString(),
        message: 'Sincronización pendiente de implementación con API real de Crehana',
      },
    };

    // En implementación real:
    // 1. Obtener cursos de Crehana API
    // 2. Upsert en platform_courses
    // 3. Obtener progreso de usuarios
    // 4. Upsert en platform_enrollments
    // 5. Actualizar mapeos de usuarios

    return result;
  }

  // =====================================================
  // LOGS DE SINCRONIZACIÓN
  // =====================================================

  async findSyncLogs(integrationId: string, limit = 20) {
    const { data, error } = await this.supabase.db
      .from('platform_sync_logs')
      .select(`
        *,
        profiles:triggered_by(id, full_name)
      `)
      .eq('platform_integration_id', integrationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data ?? [];
  }

  // =====================================================
  // HELPERS PRIVADOS
  // =====================================================

  private sanitizeIntegration(integration: any) {
    // Remover clave privada de la respuesta
    const { private_key_encrypted, ...safe } = integration;
    return {
      ...safe,
      has_private_key: !!private_key_encrypted,
    };
  }

  private async getIntegrationWithCredentials(id: string) {
    const { data, error } = await this.supabase.db
      .from('platform_integrations')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException('Integración no encontrada');
    }

    return data;
  }

  private encryptKey(text: string): string {
    const iv = crypto.randomBytes(this.ENCRYPTION_IV_LENGTH);
    const key = crypto.scryptSync(this.ENCRYPTION_KEY, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  private decryptKey(encrypted: string): string {
    const [ivHex, encryptedText] = encrypted.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.scryptSync(this.ENCRYPTION_KEY, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
