import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  OnModuleInit,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateIntegrationDto, PlatformType } from './dto/create-integration.dto';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { SyncOptionsDto, SyncType } from './dto/sync-options.dto';
import { CrehanaClient } from './clients/crehana';
import { PlatformSyncService } from './sync/platform-sync.service';
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
export class PlatformsService implements OnModuleInit {
  private readonly logger = new Logger(PlatformsService.name);

  // Clave para encriptar/desencriptar (en producción usar variable de entorno)
  private readonly ENCRYPTION_KEY = process.env.PLATFORM_ENCRYPTION_KEY || 'default-key-change-in-production-32';
  private readonly ENCRYPTION_IV_LENGTH = 16;

  /** Sync logs/integraciones que llevan más de este tiempo en 'in_progress' se consideran zombies. */
  private readonly STALE_SYNC_THRESHOLD_MS = 30 * 60 * 1000;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly crehanaClient: CrehanaClient,
    private readonly syncService: PlatformSyncService,
  ) {}

  /**
   * Al arrancar el servicio, marca como 'failed' cualquier sync que se haya
   * quedado en 'in_progress' (p.ej. porque el server se reinició a mitad
   * de un sync largo). Evita que la UI muestre eternamente "Sincronizando...".
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.cleanupStaleSyncs();
    } catch (error) {
      this.logger.error('Failed to cleanup stale syncs on startup', error);
    }
  }

  private async cleanupStaleSyncs(): Promise<void> {
    const cutoff = new Date(Date.now() - this.STALE_SYNC_THRESHOLD_MS).toISOString();

    // Sync logs huérfanos: 'in_progress' iniciados antes del corte.
    const { data: staleLogs } = await this.supabase.db
      .from('platform_sync_logs')
      .select('id, platform_integration_id')
      .eq('status', 'in_progress')
      .lt('started_at', cutoff);

    if (staleLogs && staleLogs.length > 0) {
      const logIds = staleLogs.map((l) => l.id);
      const errMsg = 'Marcado como fallido al reiniciar el servidor (zombie cleanup)';

      await this.supabase.db
        .from('platform_sync_logs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          errors_count: 1,
          error_details: { message: errMsg },
        })
        .in('id', logIds);

      // Y marcar las integraciones cuyas integraciones estén también en 'in_progress'.
      const integrationIds = [...new Set(staleLogs.map((l) => l.platform_integration_id))];

      await this.supabase.db
        .from('platform_integrations')
        .update({
          last_sync_status: 'failed',
          last_sync_error: errMsg,
          last_sync_at: new Date().toISOString(),
        })
        .in('id', integrationIds)
        .eq('last_sync_status', 'in_progress');

      this.logger.warn(
        `Cleaned up ${staleLogs.length} stale sync log(s) on startup (older than ${this.STALE_SYNC_THRESHOLD_MS / 60000} min)`,
      );
    }
  }

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
      organization_slug: dto.organization_slug ?? null,
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
        message: 'Faltan credenciales de API (URL o API Key)',
      };
    }

    try {
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
        message: error instanceof Error ? error.message : 'Error al conectar con la plataforma',
        details: error instanceof Error ? error.message : error,
      };
    }
  }

  private async testCrehanaConnection(integration: any): Promise<{ success: boolean; message: string; details?: unknown }> {
    if (!integration.organization_slug) {
      return {
        success: false,
        message: 'Falta el slug de la organización para Crehana',
      };
    }
    if (!integration.private_key_encrypted) {
      return {
        success: false,
        message: 'Falta la Secret Key de Crehana',
      };
    }

    const secretAccess = this.decryptKey(integration.private_key_encrypted);

    this.crehanaClient.configure({
      api_url: integration.api_url,
      organization_slug: integration.organization_slug,
      api_key: integration.public_key,
      secret_access: secretAccess,
    });

    const result = await this.crehanaClient.testConnection();

    return {
      success: result.success,
      message: `Conexión exitosa con Crehana (${result.users_total} usuarios, ${result.enrollments_total} inscripciones)`,
      details: result,
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

  /**
   * Inicia una sincronización en SEGUNDO PLANO y retorna inmediatamente.
   *
   * El sync con Crehana puede tardar varios minutos (un GET por cada página
   * del reporte general más los upserts en BD). Si esperáramos al await,
   * el cliente HTTP cortaría la conexión por timeout antes de que termine.
   *
   * Flujo:
   *  1. Validamos credenciales y creamos el log con status='in_progress'.
   *  2. Marcamos la integración como 'in_progress'.
   *  3. Disparamos el sync sin await — el job corre en background.
   *  4. Retornamos { sync_log_id, status: 'in_progress' } inmediatamente.
   *
   * El frontend hace polling al GET /platforms para detectar la transición
   * a 'completed' o 'failed'.
   */
  async triggerSync(integrationId: string, options: SyncOptionsDto, userId?: string) {
    const integration = await this.getIntegrationWithCredentials(integrationId);

    if (!integration.sync_enabled) {
      throw new BadRequestException('La sincronización está deshabilitada para esta integración');
    }

    if (integration.last_sync_status === 'in_progress') {
      throw new ConflictException('Ya hay una sincronización en progreso para esta integración');
    }

    const syncType = options.sync_type || SyncType.FULL;

    // Crear log de sincronización
    const { data: syncLog, error: logError } = await this.supabase.db
      .from('platform_sync_logs')
      .insert({
        platform_integration_id: integrationId,
        sync_type: syncType,
        status: 'in_progress',
        triggered_by: userId,
      })
      .select()
      .single();

    if (logError) throw logError;

    // Marcar la integración como 'in_progress' para que el frontend pueda detectarlo.
    await this.supabase.db
      .from('platform_integrations')
      .update({
        last_sync_status: 'in_progress',
        last_sync_error: null,
      })
      .eq('id', integrationId);

    // Disparar el sync en background (sin await).
    // Cualquier error se captura y se persiste en el log + integración.
    this.runSyncInBackground(integration, syncType, syncLog.id).catch((err) => {
      this.logger.error(`Background sync crashed for integration ${integrationId}`, err);
    });

    // Respuesta inmediata
    return {
      success: true,
      status: 'in_progress' as const,
      sync_log_id: syncLog.id,
      message: 'Sincronización iniciada en segundo plano',
    };
  }

  /**
   * Ejecuta el sync real (puede tardar varios minutos) y persiste el resultado.
   * Se invoca SIN await desde triggerSync.
   */
  private async runSyncInBackground(
    integration: any,
    syncType: SyncType,
    syncLogId: string,
  ): Promise<void> {
    const integrationId = integration.id;
    try {
      const result = await this.syncService.syncIntegration(integration, syncType);

      if (!result.success) {
        throw new Error(result.errors[0] || 'La sincronización falló');
      }

      await this.supabase.db
        .from('platform_sync_logs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          courses_synced: result.courses_synced,
          enrollments_synced: result.enrollments_synced,
          users_synced: result.users_synced,
          errors_count: result.errors.length,
          error_details: result.errors.length ? { errors: result.errors } : null,
          sync_summary: result.summary,
        })
        .eq('id', syncLogId);

      await this.supabase.db
        .from('platform_integrations')
        .update({
          last_sync_at: new Date().toISOString(),
          last_sync_status: 'completed',
          last_sync_error: null,
        })
        .eq('id', integrationId);

      this.logger.log(
        `Sync completed for integration ${integrationId}: ${result.users_synced} users, ${result.courses_synced} courses, ${result.enrollments_synced} enrollments`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`Sync failed for integration ${integrationId}: ${errorMessage}`);

      await this.supabase.db
        .from('platform_sync_logs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          errors_count: 1,
          error_details: { message: errorMessage },
        })
        .eq('id', syncLogId);

      await this.supabase.db
        .from('platform_integrations')
        .update({
          last_sync_at: new Date().toISOString(),
          last_sync_status: 'failed',
          last_sync_error: errorMessage,
        })
        .eq('id', integrationId);
    }
  }

  // =====================================================
  // CREHANA — VISTAS PARA EL FRONTEND
  // =====================================================
  //
  // Estos endpoints alimentan la sección /capacitacion/crehana del frontend.
  // Hoy la única plataforma sincronizada es Crehana, así que filtramos por
  // la integración cuyo platform_type='crehana'. En el futuro, si entra otra
  // plataforma (Udemy, etc.), se puede generalizar.

  /** Devuelve la integración activa de Crehana, o null si no existe. */
  private async findCrehanaIntegration() {
    const { data } = await this.supabase.db
      .from('platform_integrations')
      .select('id, last_sync_at, last_sync_status')
      .eq('platform_type', 'crehana')
      .eq('is_active', true)
      .maybeSingle();
    return data;
  }

  /**
   * KPIs agregados de Crehana para el resumen.
   */
  async getCrehanaDashboard() {
    const integration = await this.findCrehanaIntegration();
    if (!integration) {
      return {
        integration_active: false,
        total_users: 0,
        users_linked_to_abent: 0,
        total_courses: 0,
        total_enrollments: 0,
        completed_enrollments: 0,
        in_progress_enrollments: 0,
        not_started_enrollments: 0,
        total_hours_completed: 0,
        total_certificates: 0,
        average_progress: 0,
        last_sync_at: null,
        last_sync_status: null as string | null,
      };
    }

    const [usersResult, coursesResult, enrollList] = await Promise.all([
      this.supabase.db
        .from('platform_user_mappings')
        .select('id, profile_id')
        .eq('platform_integration_id', integration.id)
        .eq('is_active', true),
      this.supabase.db
        .from('platform_courses')
        .select('id')
        .eq('platform_integration_id', integration.id)
        .eq('is_active', true),
      this.getEnrollmentsForIntegration(integration.id),
    ]);

    const usersList = usersResult.data ?? [];
    const courses = coursesResult.data ?? [];

    let completed = 0;
    let inProgress = 0;
    let notStarted = 0;
    let totalHours = 0;
    let totalCertificates = 0;
    let totalProgress = 0;

    for (const e of enrollList) {
      if (e.status === 'completed') completed++;
      else if (e.status === 'in_progress') inProgress++;
      else notStarted++;
      totalHours += Number(e.hours_completed) || 0;
      if (e.certificate_url) totalCertificates++;
      totalProgress += Number(e.progress_percentage) || 0;
    }

    return {
      integration_active: true,
      total_users: usersList.length,
      users_linked_to_abent: usersList.filter((u) => u.profile_id).length,
      total_courses: courses.length,
      total_enrollments: enrollList.length,
      completed_enrollments: completed,
      in_progress_enrollments: inProgress,
      not_started_enrollments: notStarted,
      total_hours_completed: Math.round(totalHours * 10) / 10,
      total_certificates: totalCertificates,
      average_progress:
        enrollList.length > 0 ? Math.round(totalProgress / enrollList.length) : 0,
      last_sync_at: integration.last_sync_at,
      last_sync_status: integration.last_sync_status,
    };
  }

  /**
   * Lista de cursos sincronizados con stats de inscripciones por curso.
   */
  async findCrehanaCourses() {
    const integration = await this.findCrehanaIntegration();
    if (!integration) return [];

    const { data: courses } = await this.supabase.db
      .from('platform_courses')
      .select('id, external_course_id, name, total_hours, course_url, thumbnail_url, last_synced_at')
      .eq('platform_integration_id', integration.id)
      .eq('is_active', true)
      .order('name');

    if (!courses || courses.length === 0) return [];

    const courseIds = courses.map((c) => c.id);
    const { data: enrollments } = await this.supabase.db
      .from('platform_enrollments')
      .select('platform_course_id, status, progress_percentage')
      .in('platform_course_id', courseIds)
      .eq('is_active', true)
      .limit(10000);

    const statsByCourse = new Map<string, { total: number; completed: number; in_progress: number; avg_progress: number; sum: number }>();
    for (const e of enrollments ?? []) {
      const id = e.platform_course_id as string;
      const s = statsByCourse.get(id) ?? { total: 0, completed: 0, in_progress: 0, avg_progress: 0, sum: 0 };
      s.total++;
      if (e.status === 'completed') s.completed++;
      else if (e.status === 'in_progress') s.in_progress++;
      s.sum += Number(e.progress_percentage) || 0;
      statsByCourse.set(id, s);
    }

    return courses.map((c) => {
      const s = statsByCourse.get(c.id);
      return {
        ...c,
        total_enrollments: s?.total ?? 0,
        completed_enrollments: s?.completed ?? 0,
        in_progress_enrollments: s?.in_progress ?? 0,
        average_progress: s && s.total > 0 ? Math.round(s.sum / s.total) : 0,
      };
    });
  }

  /**
   * Lista de usuarios sincronizados con stats agregados (de sus inscripciones).
   */
  async findCrehanaUsers() {
    const integration = await this.findCrehanaIntegration();
    if (!integration) return [];

    const { data: mappings } = await this.supabase.db
      .from('platform_user_mappings')
      .select(`
        id, external_user_id, external_email, external_username, profile_id, last_synced_at,
        profiles:profile_id(id, full_name, email, departments(id, name))
      `)
      .eq('platform_integration_id', integration.id)
      .eq('is_active', true);

    if (!mappings || mappings.length === 0) return [];

    const enrollments = await this.getEnrollmentsForIntegration(integration.id);

    // Emparejamos por EMAIL, no por external_user_id. Crehana usa IDs distintos
    // entre el módulo de organización (users-organizations) y el de learning
    // (reports), así que el id del usuario en mappings no coincide con el de
    // las enrollments. El email sí es consistente.
    const statsByEmail = new Map<string, { total: number; completed: number; in_progress: number; hours: number; certificates: number; sum: number; lastActivity: string | null }>();
    for (const e of enrollments) {
      const email = (e.external_user_email as string | null)?.toLowerCase();
      if (!email) continue;
      const s = statsByEmail.get(email) ?? { total: 0, completed: 0, in_progress: 0, hours: 0, certificates: 0, sum: 0, lastActivity: null };
      s.total++;
      if (e.status === 'completed') s.completed++;
      else if (e.status === 'in_progress') s.in_progress++;
      s.hours += Number(e.hours_completed) || 0;
      if (e.certificate_url) s.certificates++;
      s.sum += Number(e.progress_percentage) || 0;
      if (e.last_activity_at && (!s.lastActivity || e.last_activity_at > s.lastActivity)) {
        s.lastActivity = e.last_activity_at;
      }
      statsByEmail.set(email, s);
    }

    return mappings.map((m) => {
      const s = m.external_email ? statsByEmail.get(m.external_email.toLowerCase()) : undefined;
      return {
        external_user_id: m.external_user_id,
        external_email: m.external_email,
        external_username: m.external_username,
        is_linked: !!m.profile_id,
        profile: m.profiles ?? null,
        last_synced_at: m.last_synced_at,
        total_enrollments: s?.total ?? 0,
        completed_enrollments: s?.completed ?? 0,
        in_progress_enrollments: s?.in_progress ?? 0,
        total_hours_completed: s ? Math.round(s.hours * 10) / 10 : 0,
        total_certificates: s?.certificates ?? 0,
        average_progress: s && s.total > 0 ? Math.round(s.sum / s.total) : 0,
        last_activity_at: s?.lastActivity ?? null,
      };
    });
  }

  /**
   * Detalle de un usuario: sus datos + todas sus inscripciones con info del curso.
   */
  async findCrehanaUserDetail(externalUserId: string) {
    const integration = await this.findCrehanaIntegration();
    if (!integration) {
      throw new NotFoundException('No hay integración activa con Crehana');
    }

    const { data: mapping } = await this.supabase.db
      .from('platform_user_mappings')
      .select(`
        external_user_id, external_email, external_username, profile_id, last_synced_at,
        profiles:profile_id(id, full_name, email, position, departments(id, name))
      `)
      .eq('platform_integration_id', integration.id)
      .eq('external_user_id', externalUserId)
      .maybeSingle();

    if (!mapping) {
      throw new NotFoundException('Usuario de Crehana no encontrado');
    }

    // Cursos de la integración para resolver el platform_course_id → datos del curso
    const { data: courses } = await this.supabase.db
      .from('platform_courses')
      .select('id, external_course_id, name, total_hours, course_url, thumbnail_url')
      .eq('platform_integration_id', integration.id)
      .eq('is_active', true);

    const courseById = new Map((courses ?? []).map((c) => [c.id, c]));

    // Emparejamos por email (los IDs entre módulos de Crehana no coinciden).
    const userEmail = mapping.external_email;
    const { data: enrollments } = userEmail
      ? await this.supabase.db
          .from('platform_enrollments')
          .select('*')
          .ilike('external_user_email', userEmail)
          .in('platform_course_id', Array.from(courseById.keys()))
          .eq('is_active', true)
          .order('last_activity_at', { ascending: false, nullsFirst: false })
          .limit(10000)
      : { data: [] as any[] };

    const enrichedEnrollments = (enrollments ?? []).map((e) => ({
      ...e,
      course: courseById.get(e.platform_course_id) ?? null,
    }));

    return {
      user: mapping,
      enrollments: enrichedEnrollments,
    };
  }

  /**
   * Helper: trae todas las inscripciones (rows) de una integración.
   *
   * Usa un INNER JOIN con platform_courses (filtrando por
   * platform_integration_id) para hacer todo en una sola query.
   * Subimos el límite a 10000 porque Supabase corta a 1000 por default
   * y ya tenemos ~950 enrollments — un crecimiento natural lo rompería.
   */
  private async getEnrollmentsForIntegration(integrationId: string) {
    const { data, error } = await this.supabase.db
      .from('platform_enrollments')
      .select('*, platform_courses!inner(platform_integration_id)')
      .eq('platform_courses.platform_integration_id', integrationId)
      .eq('is_active', true)
      .limit(10000);

    if (error) {
      this.logger.error(`getEnrollmentsForIntegration failed: ${error.message}`);
      throw error;
    }

    return data ?? [];
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
