import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateIntegrationDto, PlatformType } from './dto/create-integration.dto';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { SyncOptionsDto, SyncType } from './dto/sync-options.dto';
import { CrehanaClient } from './clients/crehana';
import { PlatformSyncService } from './sync/platform-sync.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { isAdmin, isManager } from '../common/utils/roles.util';
import { CryptoService } from '../common/services/crypto.service';

// Includes (equivalentes Prisma a los antiguos SELECTS de PostgREST)
const INTEGRATION_INCLUDE = {
  institutions: {
    select: { id: true, name: true, type: true, platform_url: true, annual_cost: true },
  },
} as const;

const COURSE_INCLUDE = {
  platform_integrations: {
    select: {
      id: true,
      platform_type: true,
      institutions: { select: { id: true, name: true } },
    },
  },
  course_types: { select: { id: true, name: true } },
  modalities: { select: { id: true, name: true } },
} as const;

const ENROLLMENT_INCLUDE = {
  platform_courses: {
    select: {
      id: true,
      name: true,
      external_course_id: true,
      total_hours: true,
      platform_integrations: {
        select: {
          id: true,
          platform_type: true,
          institutions: { select: { id: true, name: true } },
        },
      },
    },
  },
  profiles: {
    select: {
      id: true,
      full_name: true,
      email: true,
      departments: { select: { id: true, name: true } },
    },
  },
} as const;

@Injectable()
export class PlatformsService implements OnModuleInit {
  private readonly logger = new Logger(PlatformsService.name);

  /** Sync logs/integraciones que llevan más de este tiempo en 'in_progress' se consideran zombies. */
  private readonly STALE_SYNC_THRESHOLD_MS = 30 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crehanaClient: CrehanaClient,
    private readonly syncService: PlatformSyncService,
    private readonly cryptoService: CryptoService,
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
    const cutoff = new Date(Date.now() - this.STALE_SYNC_THRESHOLD_MS);

    // Sync logs huérfanos: 'in_progress' iniciados antes del corte.
    const staleLogs = await this.prisma.platform_sync_logs.findMany({
      where: {
        status: 'in_progress' as any,
        started_at: { lt: cutoff },
      },
      select: { id: true, platform_integration_id: true },
    });

    if (staleLogs && staleLogs.length > 0) {
      const logIds = staleLogs.map((l) => l.id);
      const errMsg = 'Marcado como fallido al reiniciar el servidor (zombie cleanup)';

      await this.prisma.platform_sync_logs.updateMany({
        where: { id: { in: logIds } },
        data: {
          status: 'failed' as any,
          completed_at: new Date(),
          errors_count: 1,
          error_details: { message: errMsg } as any,
        },
      });

      // Y marcar las integraciones cuyas integraciones estén también en 'in_progress'.
      const integrationIds = [...new Set(staleLogs.map((l) => l.platform_integration_id))];

      await this.prisma.platform_integrations.updateMany({
        where: {
          id: { in: integrationIds },
          last_sync_status: 'in_progress' as any,
        },
        data: {
          last_sync_status: 'failed' as any,
          last_sync_error: errMsg,
          last_sync_at: new Date(),
        },
      });

      this.logger.warn(
        `Cleaned up ${staleLogs.length} stale sync log(s) on startup (older than ${this.STALE_SYNC_THRESHOLD_MS / 60000} min)`,
      );
    }
  }

  // =====================================================
  // CRUD DE INTEGRACIONES
  // =====================================================

  async findAllIntegrations() {
    const data = await this.prisma.platform_integrations.findMany({
      where: { is_active: true },
      include: INTEGRATION_INCLUDE,
      orderBy: { created_at: 'desc' },
    });

    // No devolver la clave privada
    return data.map((d) => this.sanitizeIntegration(d));
  }

  async findIntegrationById(id: string) {
    const data = await this.prisma.platform_integrations.findUnique({
      where: { id },
      include: INTEGRATION_INCLUDE,
    });

    if (!data) {
      throw new NotFoundException('Integración no encontrada');
    }

    return this.sanitizeIntegration(data);
  }

  async findIntegrationByInstitution(institutionId: string) {
    const data = await this.prisma.platform_integrations.findFirst({
      where: { institution_id: institutionId, is_active: true },
      include: INTEGRATION_INCLUDE,
    });

    if (!data) {
      return null;
    }

    return this.sanitizeIntegration(data);
  }

  async createIntegration(dto: CreateIntegrationDto, userId: string) {
    // Validar que la institución existe y es tipo 'platform'
    const institution = await this.prisma.institutions.findUnique({
      where: { id: dto.institution_id },
      select: { id: true, type: true, is_active: true },
    });

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
      insertData.private_key_encrypted = this.cryptoService.encrypt(dto.private_key);
    }

    try {
      const data = await this.prisma.platform_integrations.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: insertData as any,
        include: INTEGRATION_INCLUDE,
      });

      this.logger.log(`Integration created for institution ${dto.institution_id}`);
      return this.sanitizeIntegration(data);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new ConflictException('Ya existe una integración para esta institución');
      }
      throw error;
    }
  }

  async updateIntegration(id: string, dto: UpdateIntegrationDto) {
    // Verificar que existe
    await this.findIntegrationById(id);

    const updateData: Record<string, unknown> = { ...dto };

    // Encriptar nueva clave privada si se proporciona
    if ('private_key' in dto && dto.private_key) {
      updateData.private_key_encrypted = this.cryptoService.encrypt(dto.private_key);
      delete updateData.private_key;
    }

    // No permitir cambiar institution_id
    delete updateData.institution_id;

    const data = await this.prisma.platform_integrations.update({
      where: { id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: updateData as any,
      include: INTEGRATION_INCLUDE,
    });

    this.logger.log(`Integration ${id} updated`);
    return this.sanitizeIntegration(data);
  }

  async removeIntegration(id: string) {
    await this.prisma.platform_integrations.update({
      where: { id },
      data: { is_active: false },
    });

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    const secretAccess = this.cryptoService.decrypt(integration.private_key_encrypted);

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
    const data = await this.prisma.platform_courses.findMany({
      where: { platform_integration_id: integrationId, is_active: true },
      include: COURSE_INCLUDE,
      orderBy: { name: 'asc' },
    });

    return data ?? [];
  }

  async findAllPlatformCourses() {
    const data = await this.prisma.platform_courses.findMany({
      where: { is_active: true },
      include: COURSE_INCLUDE,
      orderBy: { name: 'asc' },
    });

    return data ?? [];
  }

  async findPlatformCourseById(courseId: string) {
    const data = await this.prisma.platform_courses.findUnique({
      where: { id: courseId },
      include: COURSE_INCLUDE,
    });

    if (!data) {
      throw new NotFoundException('Curso de plataforma no encontrado');
    }
    return data;
  }

  // =====================================================
  // INSCRIPCIONES/PROGRESO
  // =====================================================

  async findEnrollmentsByProfile(profileId: string, user: AuthUser) {
    // Validar ownership:
    // - admin_rh / super_admin: cualquier perfil
    // - colaborador: solo el suyo
    // - jefe_area / director: solo colaboradores de su mismo departamento
    if (!isAdmin(user)) {
      if (user.id !== profileId) {
        if (!isManager(user)) {
          throw new ForbiddenException(
            'Solo puedes ver tu propio progreso',
          );
        }

        const target = await this.prisma.profiles.findUnique({
          where: { id: profileId },
          select: { department_id: true },
        });

        if (!target) {
          throw new NotFoundException('Colaborador no encontrado');
        }
        if (
          !user.department_id ||
          target.department_id !== user.department_id
        ) {
          throw new ForbiddenException(
            'Solo puedes ver colaboradores de tu área',
          );
        }
      }
    }

    const data = await this.prisma.platform_enrollments.findMany({
      where: { profile_id: profileId, is_active: true },
      include: ENROLLMENT_INCLUDE,
      orderBy: { last_activity_at: 'desc' },
    });

    return data ?? [];
  }

  async findEnrollmentsByDepartment(departmentId: string) {
    // Primero obtener perfiles del departamento
    const profiles = await this.prisma.profiles.findMany({
      where: { department_id: departmentId, is_active: true },
      select: { id: true },
    });

    if (!profiles || profiles.length === 0) return [];

    const profileIds = profiles.map((p) => p.id);

    const data = await this.prisma.platform_enrollments.findMany({
      where: { profile_id: { in: profileIds }, is_active: true },
      include: ENROLLMENT_INCLUDE,
      orderBy: { last_activity_at: 'desc' },
    });

    return data ?? [];
  }

  async getEnrollmentsSummary() {
    // Resumen general de progreso en plataformas
    const enrollments = await this.prisma.platform_enrollments.findMany({
      where: { is_active: true },
      select: {
        id: true,
        status: true,
        progress_percentage: true,
        hours_completed: true,
        platform_courses: {
          select: {
            platform_integrations: { select: { platform_type: true } },
          },
        },
      },
    });

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
        summary.by_status[e.status as unknown as keyof typeof summary.by_status]++;

        // Horas totales
        summary.total_hours_completed += Number(e.hours_completed) || 0;

        // Progreso promedio
        totalProgress += Number(e.progress_percentage) || 0;

        // Por plataforma
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const syncLog = await this.prisma.platform_sync_logs.create({
      data: {
        platform_integration_id: integrationId,
        sync_type: syncType,
        status: 'in_progress' as any,
        triggered_by: userId,
      },
    });

    // Marcar la integración como 'in_progress' para que el frontend pueda detectarlo.
    await this.prisma.platform_integrations.update({
      where: { id: integrationId },
      data: {
        last_sync_status: 'in_progress' as any,
        last_sync_error: null,
      },
    });

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

      await this.prisma.platform_sync_logs.update({
        where: { id: syncLogId },
        data: {
          status: 'completed' as any,
          completed_at: new Date(),
          courses_synced: result.courses_synced,
          enrollments_synced: result.enrollments_synced,
          users_synced: result.users_synced,
          errors_count: result.errors.length,
          error_details: result.errors.length ? ({ errors: result.errors } as any) : (null as any),
          sync_summary: result.summary as any,
        },
      });

      await this.prisma.platform_integrations.update({
        where: { id: integrationId },
        data: {
          last_sync_at: new Date(),
          last_sync_status: 'completed' as any,
          last_sync_error: null,
        },
      });

      this.logger.log(
        `Sync completed for integration ${integrationId}: ${result.users_synced} users, ${result.courses_synced} courses, ${result.enrollments_synced} enrollments`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`Sync failed for integration ${integrationId}: ${errorMessage}`);

      await this.prisma.platform_sync_logs.update({
        where: { id: syncLogId },
        data: {
          status: 'failed' as any,
          completed_at: new Date(),
          errors_count: 1,
          error_details: { message: errorMessage } as any,
        },
      });

      await this.prisma.platform_integrations.update({
        where: { id: integrationId },
        data: {
          last_sync_at: new Date(),
          last_sync_status: 'failed' as any,
          last_sync_error: errorMessage,
        },
      });
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
    const data = await this.prisma.platform_integrations.findFirst({
      where: { platform_type: 'crehana' as any, is_active: true },
      select: { id: true, last_sync_at: true, last_sync_status: true },
    });
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

    const [usersList, courses, enrollList] = await Promise.all([
      this.prisma.platform_user_mappings.findMany({
        where: { platform_integration_id: integration.id, is_active: true },
        select: { id: true, profile_id: true },
      }),
      this.prisma.platform_courses.findMany({
        where: { platform_integration_id: integration.id, is_active: true },
        select: { id: true },
      }),
      this.getEnrollmentsForIntegration(integration.id),
    ]);

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

    const courses = await this.prisma.platform_courses.findMany({
      where: { platform_integration_id: integration.id, is_active: true },
      select: {
        id: true,
        external_course_id: true,
        name: true,
        total_hours: true,
        course_url: true,
        thumbnail_url: true,
        last_synced_at: true,
      },
      orderBy: { name: 'asc' },
    });

    if (!courses || courses.length === 0) return [];

    const courseIds = courses.map((c) => c.id);
    const enrollments = await this.prisma.platform_enrollments.findMany({
      where: { platform_course_id: { in: courseIds }, is_active: true },
      select: { platform_course_id: true, status: true, progress_percentage: true },
      take: 10000,
    });

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

    const mappingsRaw = await this.prisma.platform_user_mappings.findMany({
      where: { platform_integration_id: integration.id, is_active: true },
      select: {
        id: true,
        external_user_id: true,
        external_email: true,
        external_username: true,
        profile_id: true,
        last_synced_at: true,
        profiles: {
          select: {
            id: true,
            full_name: true,
            email: true,
            departments: { select: { id: true, name: true } },
          },
        },
      },
    });

    // Mantener forma original (campo `profiles` -> el frontend espera `profiles`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mappings = mappingsRaw as any[];

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
      const lastAct: string | null = e.last_activity_at
        ? (e.last_activity_at instanceof Date ? e.last_activity_at.toISOString() : String(e.last_activity_at))
        : null;
      if (lastAct && (!s.lastActivity || lastAct > s.lastActivity)) {
        s.lastActivity = lastAct;
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
   * Detalle de un curso: datos del curso + stats agregadas + lista de inscritos
   * con su progreso individual.
   */
  async findCrehanaCourseDetail(externalCourseId: string) {
    const integration = await this.findCrehanaIntegration();
    if (!integration) {
      throw new NotFoundException('No hay integración activa con Crehana');
    }

    // Curso
    const course = await this.prisma.platform_courses.findFirst({
      where: {
        platform_integration_id: integration.id,
        external_course_id: externalCourseId,
        is_active: true,
      },
      select: {
        id: true,
        external_course_id: true,
        name: true,
        total_hours: true,
        course_url: true,
        thumbnail_url: true,
        last_synced_at: true,
        description: true,
        instructor: true,
        total_modules: true,
        total_lessons: true,
      },
    });

    if (!course) {
      throw new NotFoundException('Curso de Crehana no encontrado');
    }

    // Inscripciones del curso
    const enrollments = await this.prisma.platform_enrollments.findMany({
      where: { platform_course_id: course.id, is_active: true },
      orderBy: { progress_percentage: 'desc' },
      take: 10000,
    });

    const enrollList = enrollments ?? [];

    // Resolver info de cada usuario por email (recordar: external_user_id NO
    // coincide con el id del mapping, debemos joinear por email).
    const emails = enrollList
      .map((e) => (e.external_user_email as string | null)?.toLowerCase())
      .filter((e): e is string => !!e);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mappings: any[] = emails.length > 0
      ? await this.prisma.platform_user_mappings.findMany({
          where: { platform_integration_id: integration.id, is_active: true },
          select: {
            external_user_id: true,
            external_email: true,
            external_username: true,
            profile_id: true,
            profiles: {
              select: {
                id: true,
                full_name: true,
                email: true,
                departments: { select: { id: true, name: true } },
              },
            },
          },
        })
      : [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mappingByEmail = new Map<string, any>();
    for (const m of mappings ?? []) {
      if (m.external_email) {
        mappingByEmail.set(m.external_email.toLowerCase(), m);
      }
    }

    // Stats agregadas
    let completed = 0;
    let inProgress = 0;
    let notStarted = 0;
    let totalHours = 0;
    let certificates = 0;
    let totalProgress = 0;

    const enrichedEnrollments = enrollList.map((e) => {
      if (e.status === 'completed') completed++;
      else if (e.status === 'in_progress') inProgress++;
      else notStarted++;
      totalHours += Number(e.hours_completed) || 0;
      if (e.certificate_url) certificates++;
      totalProgress += Number(e.progress_percentage) || 0;

      const email = (e.external_user_email as string | null)?.toLowerCase();
      const m = email ? mappingByEmail.get(email) : null;

      return {
        id: e.id,
        status: e.status,
        progress_percentage: e.progress_percentage,
        hours_completed: e.hours_completed,
        enrolled_at: e.enrolled_at,
        started_at: e.started_at,
        completed_at: e.completed_at,
        last_activity_at: e.last_activity_at,
        certificate_url: e.certificate_url,
        certificate_issued_at: e.certificate_issued_at,
        user: m
          ? {
              external_user_id: m.external_user_id,
              external_email: m.external_email,
              external_username: m.external_username,
              is_linked: !!m.profile_id,
              profile: m.profiles ?? null,
            }
          : {
              external_user_id: null,
              external_email: e.external_user_email,
              external_username: null,
              is_linked: false,
              profile: null,
            },
      };
    });

    return {
      course,
      stats: {
        total_enrollments: enrollList.length,
        completed,
        in_progress: inProgress,
        not_started: notStarted,
        average_progress:
          enrollList.length > 0 ? Math.round(totalProgress / enrollList.length) : 0,
        total_hours_studied: Math.round(totalHours * 10) / 10,
        certificates_issued: certificates,
      },
      enrollments: enrichedEnrollments,
    };
  }

  /**
   * Detalle de un usuario: sus datos + todas sus inscripciones con info del curso.
   */
  async findCrehanaUserDetail(externalUserId: string) {
    const integration = await this.findCrehanaIntegration();
    if (!integration) {
      throw new NotFoundException('No hay integración activa con Crehana');
    }

    const mapping = await this.prisma.platform_user_mappings.findFirst({
      where: {
        platform_integration_id: integration.id,
        external_user_id: externalUserId,
      },
      select: {
        external_user_id: true,
        external_email: true,
        external_username: true,
        profile_id: true,
        last_synced_at: true,
        profiles: {
          select: {
            id: true,
            full_name: true,
            email: true,
            position: true,
            departments: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!mapping) {
      throw new NotFoundException('Usuario de Crehana no encontrado');
    }

    // Cursos de la integración para resolver el platform_course_id → datos del curso
    const courses = await this.prisma.platform_courses.findMany({
      where: { platform_integration_id: integration.id, is_active: true },
      select: {
        id: true,
        external_course_id: true,
        name: true,
        total_hours: true,
        course_url: true,
        thumbnail_url: true,
      },
    });

    const courseById = new Map((courses ?? []).map((c) => [c.id, c]));

    // Emparejamos por email (los IDs entre módulos de Crehana no coinciden).
    const userEmail = mapping.external_email;
    const enrollments = userEmail
      ? await this.prisma.platform_enrollments.findMany({
          where: {
            external_user_email: { equals: userEmail, mode: 'insensitive' },
            platform_course_id: { in: Array.from(courseById.keys()) },
            is_active: true,
          },
          orderBy: { last_activity_at: { sort: 'desc', nulls: 'last' } },
          take: 10000,
        })
      : [];

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
    try {
      const data = await this.prisma.platform_enrollments.findMany({
        where: {
          is_active: true,
          platform_courses: { platform_integration_id: integrationId },
        },
        take: 10000,
      });

      return data ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.logger.error(`getEnrollmentsForIntegration failed: ${error?.message ?? error}`);
      throw error;
    }
  }

  // =====================================================
  // LOGS DE SINCRONIZACIÓN
  // =====================================================

  async findSyncLogs(integrationId: string, limit = 20) {
    const data = await this.prisma.platform_sync_logs.findMany({
      where: { platform_integration_id: integrationId },
      include: {
        profiles: { select: { id: true, full_name: true } },
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });

    return data ?? [];
  }

  // =====================================================
  // HELPERS PRIVADOS
  // =====================================================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sanitizeIntegration(integration: any) {
    // Remover clave privada de la respuesta
    const { private_key_encrypted, ...safe } = integration;
    return {
      ...safe,
      has_private_key: !!private_key_encrypted,
    };
  }

  private async getIntegrationWithCredentials(id: string) {
    const data = await this.prisma.platform_integrations.findUnique({
      where: { id },
    });

    if (!data) {
      throw new NotFoundException('Integración no encontrada');
    }

    return data;
  }

}
