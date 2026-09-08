import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { CrehanaClient, CrehanaMapper } from '../clients/crehana';
import { SyncType } from '../dto/sync-options.dto';
import { CryptoService } from '../../common/services/crypto.service';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly crehanaClient: CrehanaClient,
    private readonly cryptoService: CryptoService,
  ) {}

  /**
   * Sincronización automática de todas las integraciones habilitadas.
   * El cron corre cada 6 horas, pero respeta sync_frequency_hours por integración.
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async scheduledSync(): Promise<void> {
    this.logger.log('Starting scheduled platform sync...');

    const integrations = await this.prisma.platform_integrations.findMany({
      where: { is_active: true, sync_enabled: true },
    });

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const profiles = await this.prisma.profiles.findMany({
      where: { is_active: true },
      select: { id: true, email: true },
    });

    const profileByEmail = new Map<string, string>();
    for (const p of profiles ?? []) {
      if (p.email) profileByEmail.set(p.email.toLowerCase(), p.id);
    }

    for await (const user of this.crehanaClient.iterateUsers()) {
      try {
        const matchedProfileId = user.user.email
          ? profileByEmail.get(user.user.email.toLowerCase()) ?? null
          : null;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mapping = CrehanaMapper.userMapping(user, integrationId, matchedProfileId) as any;

        try {
          await this.prisma.platform_user_mappings.upsert({
            where: {
              platform_integration_id_external_user_id: {
                platform_integration_id: mapping.platform_integration_id,
                external_user_id: mapping.external_user_id,
              },
            },
            create: mapping,
            update: mapping,
          });
          result.users_synced++;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (upsertError: any) {
          result.errors.push(
            `Error guardando usuario ${user.user.email}: ${upsertError?.message ?? 'desconocido'}`,
          );
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
    const profiles = await this.prisma.profiles.findMany({
      where: { is_active: true },
      select: { id: true, email: true },
    });

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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const courseData = CrehanaMapper.courseFromReportRow(row, integrationId) as any;

          try {
            const upserted = await this.prisma.platform_courses.upsert({
              where: {
                platform_integration_id_external_course_id: {
                  platform_integration_id: courseData.platform_integration_id,
                  external_course_id: courseData.external_course_id,
                },
              },
              create: courseData,
              update: courseData,
              select: { id: true },
            });

            if (!upserted?.id) {
              result.errors.push(`Error guardando curso ${row.course_name}: sin id`);
              continue;
            }

            platformCourseId = upserted.id as string;
            courseCache.set(row.course_id, platformCourseId);
            result.courses_synced++;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (courseError: any) {
            result.errors.push(
              `Error guardando curso ${row.course_name}: ${courseError?.message ?? 'sin id'}`,
            );
            continue;
          }
        }

        // 2) Resolver profile_id por email
        const profileId = row.user_email
          ? profileByEmail.get(row.user_email.toLowerCase()) ?? null
          : null;

        // 3) Upsert de enrollment
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const enrollment = CrehanaMapper.enrollmentFromReportRow(
          row,
          platformCourseId,
          profileId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;

        try {
          await this.prisma.platform_enrollments.upsert({
            where: {
              platform_course_id_external_user_id: {
                platform_course_id: enrollment.platform_course_id,
                external_user_id: enrollment.external_user_id,
              },
            },
            create: enrollment,
            update: enrollment,
          });
          result.enrollments_synced++;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (enrollError: any) {
          result.errors.push(
            `Error guardando inscripción ${row.user_email}/${row.course_name}: ${enrollError?.message ?? 'desconocido'}`,
          );
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

  /**
   * Descifra vía CryptoService preservando el comportamiento previo de este
   * servicio: ante un ciphertext inválido devuelve '' (el caller lo traduce a
   * "Faltan credenciales") en lugar de propagar la excepción.
   */
  private decryptKey(encrypted: string): string {
    try {
      return this.cryptoService.decrypt(encrypted);
    } catch {
      return '';
    }
  }
}
