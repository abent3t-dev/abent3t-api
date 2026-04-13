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
  private readonly ENCRYPTION_KEY = process.env.PLATFORM_ENCRYPTION_KEY || 'default-key-change-in-production-32';

  constructor(
    private readonly supabase: SupabaseService,
    private readonly crehanaClient: CrehanaClient,
  ) {}

  /**
   * Sincronización automática de todas las integraciones habilitadas
   * Se ejecuta cada 6 horas automáticamente
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async scheduledSync(): Promise<void> {
    this.logger.log('Starting scheduled platform sync...');

    try {
      // Obtener integraciones con sincronización habilitada
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
        // Verificar si ha pasado suficiente tiempo desde la última sincronización
        const lastSync = integration.last_sync_at
          ? new Date(integration.last_sync_at)
          : null;
        const hoursElapsed = lastSync
          ? (Date.now() - lastSync.getTime()) / (1000 * 60 * 60)
          : Infinity;

        if (hoursElapsed >= (integration.sync_frequency_hours || 24)) {
          this.logger.log(`Syncing integration ${integration.id} (${integration.platform_type})`);

          try {
            await this.syncIntegration(integration, SyncType.INCREMENTAL);
          } catch (error) {
            this.logger.error(`Failed to sync integration ${integration.id}`, error);
          }
        }
      }

      this.logger.log('Scheduled platform sync completed');
    } catch (error) {
      this.logger.error('Scheduled sync failed', error);
    }
  }

  /**
   * Sincronizar una integración específica
   */
  async syncIntegration(
    integration: any,
    syncType: SyncType,
  ): Promise<SyncResult> {
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
      // Configurar cliente según tipo de plataforma
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

  /**
   * Sincronización específica para Crehana
   */
  private async syncCrehana(
    integration: any,
    syncType: SyncType,
    result: SyncResult,
  ): Promise<void> {
    // Configurar cliente con credenciales
    const privateKey = integration.private_key_encrypted
      ? this.decryptKey(integration.private_key_encrypted)
      : '';

    this.crehanaClient.configure({
      api_url: integration.api_url,
      public_key: integration.public_key,
      private_key: privateKey,
    });

    // Verificar conexión
    const connected = await this.crehanaClient.testConnection();
    if (!connected) {
      throw new Error('No se pudo conectar con Crehana');
    }

    // Sincronizar según tipo
    switch (syncType) {
      case SyncType.FULL:
        await this.syncCrehanaUsers(integration.id, result);
        await this.syncCrehanaCourses(integration.id, result);
        await this.syncCrehanaProgress(integration.id, result);
        break;

      case SyncType.USERS:
        await this.syncCrehanaUsers(integration.id, result);
        break;

      case SyncType.COURSES:
        await this.syncCrehanaCourses(integration.id, result);
        break;

      case SyncType.PROGRESS:
      case SyncType.INCREMENTAL:
        await this.syncCrehanaProgress(integration.id, result);
        break;
    }
  }

  /**
   * Sincronizar usuarios de Crehana
   */
  private async syncCrehanaUsers(
    integrationId: string,
    result: SyncResult,
  ): Promise<void> {
    try {
      const response = await this.crehanaClient.listUsers();

      if (!response.success || !response.data) {
        result.errors.push('Error al obtener usuarios de Crehana');
        return;
      }

      for (const crehanaUser of response.data) {
        try {
          // Buscar perfil interno por email
          const { data: profile } = await this.supabase.db
            .from('profiles')
            .select('id')
            .eq('email', crehanaUser.email)
            .eq('is_active', true)
            .single();

          if (profile) {
            // Upsert en platform_user_mappings
            const mapping = CrehanaMapper.toUserMapping(
              crehanaUser,
              integrationId,
              profile.id,
            );

            await this.supabase.db
              .from('platform_user_mappings')
              .upsert(mapping, {
                onConflict: 'platform_integration_id,external_user_id',
              });

            result.users_synced++;
          }
        } catch (error) {
          result.errors.push(`Error sincronizando usuario ${crehanaUser.email}`);
        }
      }
    } catch (error) {
      result.errors.push('Error general sincronizando usuarios');
    }
  }

  /**
   * Sincronizar cursos de Crehana
   */
  private async syncCrehanaCourses(
    integrationId: string,
    result: SyncResult,
  ): Promise<void> {
    try {
      const response = await this.crehanaClient.getCourses();

      if (!response.success || !response.data) {
        result.errors.push('Error al obtener cursos de Crehana');
        return;
      }

      for (const crehanaCourse of response.data) {
        try {
          const course = CrehanaMapper.toPlatformCourse(crehanaCourse, integrationId);

          await this.supabase.db
            .from('platform_courses')
            .upsert(course, {
              onConflict: 'platform_integration_id,external_course_id',
            });

          result.courses_synced++;
        } catch (error) {
          result.errors.push(`Error sincronizando curso ${crehanaCourse.title}`);
        }
      }
    } catch (error) {
      result.errors.push('Error general sincronizando cursos');
    }
  }

  /**
   * Sincronizar progreso de Crehana
   */
  private async syncCrehanaProgress(
    integrationId: string,
    result: SyncResult,
  ): Promise<void> {
    try {
      const response = await this.crehanaClient.getAllUsersProgress();

      if (!response.success || !response.data) {
        result.errors.push('Error al obtener progreso de Crehana');
        return;
      }

      // Obtener mapeos de usuarios
      const { data: userMappings } = await this.supabase.db
        .from('platform_user_mappings')
        .select('profile_id, external_user_id')
        .eq('platform_integration_id', integrationId)
        .eq('is_active', true);

      const userMap = new Map(
        userMappings?.map((m) => [m.external_user_id, m.profile_id]) ?? [],
      );

      // Obtener mapeo de cursos
      const { data: courseMappings } = await this.supabase.db
        .from('platform_courses')
        .select('id, external_course_id')
        .eq('platform_integration_id', integrationId)
        .eq('is_active', true);

      const courseMap = new Map(
        courseMappings?.map((c) => [c.external_course_id, c.id]) ?? [],
      );

      for (const userProgress of response.data) {
        const profileId = userMap.get(userProgress.user_id);
        if (!profileId) continue;

        for (const courseProgress of userProgress.courses) {
          const platformCourseId = courseMap.get(courseProgress.course_id);
          if (!platformCourseId) continue;

          try {
            const enrollment = CrehanaMapper.toPlatformEnrollment(
              courseProgress,
              platformCourseId,
              profileId,
              userProgress.user_id,
            );

            await this.supabase.db
              .from('platform_enrollments')
              .upsert(enrollment, {
                onConflict: 'platform_course_id,profile_id',
              });

            result.enrollments_synced++;
          } catch (error) {
            result.errors.push(
              `Error sincronizando progreso: usuario ${userProgress.user_email}, curso ${courseProgress.course_title}`,
            );
          }
        }
      }
    } catch (error) {
      result.errors.push('Error general sincronizando progreso');
    }
  }

  /**
   * Desencriptar clave privada
   */
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
