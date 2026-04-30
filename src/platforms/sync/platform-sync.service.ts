import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { CrehanaClient, CrehanaMapper } from '../clients/crehana';
import { SyncType } from '../dto/sync-options.dto';
import * as crypto from 'crypto';

export interface SyncResult {
  success: boolean;
  courses_synced: number;
  enrollments_synced: number;
  users_synced: number;
  errors: string[];
  summary: Record<string, unknown>;
}

@Injectable()
export class PlatformSyncService {
  private readonly logger = new Logger(PlatformSyncService.name);

  // Clave para desencriptar (debe coincidir con PlatformsService)
  private readonly ENCRYPTION_KEY =
    process.env.PLATFORM_ENCRYPTION_KEY || 'default-key-change-in-production-32';

  constructor(
    private readonly supabase: SupabaseService,
    private readonly crehanaClient: CrehanaClient,
  ) {}

  /**
   * Sincronización automática de todas las integraciones habilitadas.
   * El cron corre cada 6 horas, pero respeta sync_frequency_hours por integración.
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async scheduledSync(): Promise<void> {
    this.logger.log('Starting scheduled platform sync...');

    const { data: integrations } = await this.supabase.db
      .from('platform_integrations')
      .select('*')
      .eq('is_active', true)
      .eq('sync_enabled', true);

    if (!integrations || integrations.length === 0) {
      this.logger.log('No integrations with sync enabled');
      return;
    }

    for (const integration of integrations) {
      const lastSync = integration.last_sync_at ? new Date(integration.last_sync_at) : null;
      const hoursElapsed = lastSync
        ? (Date.now() - lastSync.getTime()) / (1000 * 60 * 60)
        : Infinity;

      if (hoursElapsed >= (integration.sync_frequency_hours || 24)) {
        this.logger.log(
          `Syncing integration ${integration.id} (${integration.platform_type})`,
        );
        try {
          await this.syncIntegration(integration, SyncType.INCREMENTAL);
        } catch (error) {
          this.logger.error(`Failed to sync integration ${integration.id}`, error);
        }
      }
    }

    this.logger.log('Scheduled platform sync completed');
  }

  /**
   * Sincronizar una integración específica.
   */
  async syncIntegration(integration: any, syncType: SyncType): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      courses_synced: 0,
      enrollments_synced: 0,
      users_synced: 0,
      errors: [],
      summary: {
        integration_id: integration.id,
        platform_type: integration.platform_type,
        sync_type: syncType,
        started_at: new Date().toISOString(),
      },
    };

    try {
      if (integration.platform_type === 'crehana') {
        await this.syncCrehana(integration, syncType, result);
      } else {
        result.errors.push(`Plataforma no soportada: ${integration.platform_type}`);
        result.success = false;
      }
    } catch (error) {
      result.success = false;
      result.errors.push(error instanceof Error ? error.message : 'Error desconocido');
    }

    result.summary.completed_at = new Date().toISOString();
    result.summary.success = result.success;

    return result;
  }

  // =====================================================
  // CREHANA
  // =====================================================

  private async syncCrehana(
    integration: any,
    syncType: SyncType,
    result: SyncResult,
  ): Promise<void> {
    const secretAccess = integration.private_key_encrypted
      ? this.decryptKey(integration.private_key_encrypted)
      : '';

    if (!integration.api_url || !integration.organization_slug || !integration.public_key || !secretAccess) {
      throw new Error('Faltan credenciales o slug de Crehana en la integración');
    }

    this.crehanaClient.configure({
      api_url: integration.api_url,
      organization_slug: integration.organization_slug,
      api_key: integration.public_key,
      secret_access: secretAccess,
    });

    // Validar conexión antes de empezar
    await this.crehanaClient.testConnection();

    // Para nuestro alcance (sólo lectura, mostrar info), siempre conviene
    // sincronizar usuarios primero (para tener mapeos por email),
    // y después el reporte general que crea cursos + inscripciones en una pasada.
    switch (syncType) {
      case SyncType.FULL:
      case SyncType.INCREMENTAL:
        await this.syncCrehanaUsers(integration.id, result);
        await this.syncCrehanaCoursesAndEnrollments(integration.id, result);
        break;

      case SyncType.USERS:
        await this.syncCrehanaUsers(integration.id, result);
        break;

      case SyncType.COURSES:
      case SyncType.PROGRESS:
        await this.syncCrehanaCoursesAndEnrollments(integration.id, result);
        break;
    }
  }

  /**
   * Sincronizar TODOS los usuarios de Crehana.
   * Si el email coincide con un perfil de ABENT → se enlaza.
   * Si no coincide → se guarda con profile_id NULL (visible en UI sin enlazar).
   */
  private async syncCrehanaUsers(integrationId: string, result: SyncResult): Promise<void> {
    // Pre-cargar el mapa de profiles por email (case-insensitive).
    const { data: profiles } = await this.supabase.db
      .from('profiles')
      .select('id, email')
      .eq('is_active', true);

    const profileByEmail = new Map<string, string>();
    for (const p of profiles ?? []) {
      if (p.email) profileByEmail.set(p.email.toLowerCase(), p.id);
    }

    for await (const user of this.crehanaClient.iterateUsers()) {
      try {
        const matchedProfileId = user.user.email
          ? profileByEmail.get(user.user.email.toLowerCase()) ?? null
          : null;

        const mapping = CrehanaMapper.userMapping(user, integrationId, matchedProfileId);

        const { error } = await this.supabase.db
          .from('platform_user_mappings')
          .upsert(mapping, { onConflict: 'platform_integration_id,external_user_id' });

        if (error) {
          result.errors.push(`Error guardando usuario ${user.user.email}: ${error.message}`);
        } else {
          result.users_synced++;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'desconocido';
        result.errors.push(`Error sincronizando usuario ${user.user.email}: ${msg}`);
      }
    }
  }

  /**
   * Sincronización combinada: cursos + inscripciones, ambas alimentadas
   * desde el reporte general (que trae filas user+course).
   *
   * - Cada course_id único se upserta en platform_courses.
   * - Cada fila se upserta en platform_enrollments.
   * - profile_id se resuelve por email; si no hay match queda NULL.
   *
   * Esto cumple el alcance "solo cursos donde haya inscritos" sin necesidad
   * de sincronizar el catálogo completo.
   */
  private async syncCrehanaCoursesAndEnrollments(
    integrationId: string,
    result: SyncResult,
  ): Promise<void> {
    // Pre-cargar profiles por email (para resolver profile_id en cada fila)
    const { data: profiles } = await this.supabase.db
      .from('profiles')
      .select('id, email')
      .eq('is_active', true);

    const profileByEmail = new Map<string, string>();
    for (const p of profiles ?? []) {
      if (p.email) profileByEmail.set(p.email.toLowerCase(), p.id);
    }

    // Cache de course_id externo → id interno (para no upsertar duplicados de curso).
    const courseCache = new Map<string, string>();

    for await (const row of this.crehanaClient.iterateGeneralReport()) {
      try {
        // 1) Asegurar curso (upsert + recuperar id interno)
        let platformCourseId: string | undefined = courseCache.get(row.course_id);
        if (!platformCourseId) {
          const courseData = CrehanaMapper.courseFromReportRow(row, integrationId);

          const { data: upserted, error: courseError } = await this.supabase.db
            .from('platform_courses')
            .upsert(courseData, {
              onConflict: 'platform_integration_id,external_course_id',
            })
            .select('id')
            .single();

          if (courseError || !upserted?.id) {
            result.errors.push(
              `Error guardando curso ${row.course_name}: ${courseError?.message ?? 'sin id'}`,
            );
            continue;
          }

          platformCourseId = upserted.id as string;
          courseCache.set(row.course_id, platformCourseId);
          result.courses_synced++;
        }

        // 2) Resolver profile_id por email
        const profileId = row.user_email
          ? profileByEmail.get(row.user_email.toLowerCase()) ?? null
          : null;

        // 3) Upsert de enrollment
        const enrollment = CrehanaMapper.enrollmentFromReportRow(
          row,
          platformCourseId,
          profileId,
        );

        const { error: enrollError } = await this.supabase.db
          .from('platform_enrollments')
          .upsert(enrollment, {
            onConflict: 'platform_course_id,external_user_id',
          });

        if (enrollError) {
          result.errors.push(
            `Error guardando inscripción ${row.user_email}/${row.course_name}: ${enrollError.message}`,
          );
        } else {
          result.enrollments_synced++;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'desconocido';
        result.errors.push(
          `Error procesando fila ${row.user_email}/${row.course_name}: ${msg}`,
        );
      }
    }
  }

  // =====================================================
  // UTILIDADES
  // =====================================================

  private decryptKey(encrypted: string): string {
    try {
      const [ivHex, encryptedText] = encrypted.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const key = crypto.scryptSync(this.ENCRYPTION_KEY, 'salt', 32);
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return '';
    }
  }
}
