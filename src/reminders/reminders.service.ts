import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

interface PendingEvidenceRecord {
  id: string;
  status: string;
  profile_id: string;
  enrolled_at: Date | string;
  course_editions: {
    id: string;
    end_date: Date | string | null;
    require_evidence_for_completion: boolean;
    courses: {
      id: string;
      name: string;
      institutions: { name: string } | null;
    };
  };
  profiles: {
    id: string;
    full_name: string;
    email: string;
    department_id: string | null;
    departments: { id: string; name: string } | null;
  };
}

interface ReminderConfig {
  // Días después de finalizar el curso para enviar el primer recordatorio
  firstReminderDays: number;
  // Días adicionales para enviar recordatorio de seguimiento
  followUpReminderDays: number;
  // Días para escalar a RRHH
  escalationDays: number;
  // Si los recordatorios están habilitados
  enabled: boolean;
}

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);
  private readonly config: ReminderConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {
    // Configuración de recordatorios (puede venir de env o base de datos)
    this.config = {
      firstReminderDays: parseInt(this.configService.get('REMINDER_FIRST_DAYS') || '3', 10),
      followUpReminderDays: parseInt(this.configService.get('REMINDER_FOLLOWUP_DAYS') || '7', 10),
      escalationDays: parseInt(this.configService.get('REMINDER_ESCALATION_DAYS') || '14', 10),
      enabled: this.configService.get('REMINDERS_ENABLED') !== 'false',
    };

    this.logger.log(`📅 Servicio de recordatorios inicializado. Habilitado: ${this.config.enabled}`);
    this.logger.log(`   - Primer recordatorio: ${this.config.firstReminderDays} días`);
    this.logger.log(`   - Seguimiento: ${this.config.followUpReminderDays} días`);
    this.logger.log(`   - Escalamiento a RRHH: ${this.config.escalationDays} días`);
  }

  /**
   * Cron job que corre todos los días a las 9:00 AM
   * Verifica evidencias pendientes y envía recordatorios
   */
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async checkPendingEvidences(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.debug('Recordatorios deshabilitados, saltando verificación');
      return;
    }

    this.logger.log('🔍 Iniciando verificación de evidencias pendientes...');

    try {
      const pendingRecords = await this.getPendingEvidenceRecords();
      this.logger.log(`   Encontradas ${pendingRecords.length} inscripciones con evidencia pendiente`);

      let firstReminders = 0;
      let followUpReminders = 0;
      let escalations = 0;

      for (const record of pendingRecords) {
        const daysPending = this.calculateDaysPending(record);

        if (daysPending >= this.config.escalationDays) {
          // Escalar a RRHH
          await this.sendEscalationEmail(record, daysPending);
          escalations++;
        } else if (daysPending >= this.config.followUpReminderDays) {
          // Recordatorio de seguimiento
          await this.sendReminderEmail(record, daysPending, true);
          followUpReminders++;
        } else if (daysPending >= this.config.firstReminderDays) {
          // Primer recordatorio
          await this.sendReminderEmail(record, daysPending, false);
          firstReminders++;
        }
      }

      this.logger.log(`✅ Recordatorios procesados:`);
      this.logger.log(`   - Primeros recordatorios: ${firstReminders}`);
      this.logger.log(`   - Seguimientos: ${followUpReminders}`);
      this.logger.log(`   - Escalamientos a RRHH: ${escalations}`);

      // Registrar en log de auditoría (opcional)
      await this.logReminderExecution({
        totalPending: pendingRecords.length,
        firstReminders,
        followUpReminders,
        escalations,
      });
    } catch (error) {
      this.logger.error('Error al procesar recordatorios:', error);
    }
  }

  /**
   * Obtiene todas las inscripciones con evidencia pendiente
   */
  private async getPendingEvidenceRecords(): Promise<PendingEvidenceRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any[];
    try {
      data = await this.prisma.course_enrollments.findMany({
        where: {
          is_active: true,
          status: { in: ['pendiente_evidencia', 'completo'] },
          course_editions: {
            require_evidence_for_completion: { not: false },
          },
        },
        select: {
          id: true,
          status: true,
          profile_id: true,
          enrolled_at: true,
          course_editions: {
            select: {
              id: true,
              end_date: true,
              require_evidence_for_completion: true,
              courses: {
                select: {
                  id: true,
                  name: true,
                  institutions: { select: { name: true } },
                },
              },
            },
          },
          profiles: {
            select: {
              id: true,
              full_name: true,
              email: true,
              department_id: true,
              departments: { select: { id: true, name: true } },
            },
          },
        },
      });
    } catch (error) {
      this.logger.error('Error obteniendo registros pendientes:', error);
      throw error;
    }

    // Filtrar solo los que no tienen evidencia aprobada
    const pendingRecords: PendingEvidenceRecord[] = [];

    for (const record of data || []) {
      const hasApprovedEvidence = await this.checkApprovedEvidence(record.id);
      if (!hasApprovedEvidence) {
        const edition = record.course_editions;
        const profile = record.profiles;

        if (!edition || !profile) continue;

        // Cast seguro: validamos estructura antes de agregar
        const typedRecord: PendingEvidenceRecord = {
          id: record.id,
          status: record.status,
          profile_id: record.profile_id,
          enrolled_at: record.enrolled_at,
          course_editions: {
            id: edition.id,
            end_date: edition.end_date,
            require_evidence_for_completion: edition.require_evidence_for_completion,
            courses: edition.courses,
          } as PendingEvidenceRecord['course_editions'],
          profiles: {
            id: profile.id,
            full_name: profile.full_name,
            email: profile.email,
            department_id: profile.department_id,
            departments: profile.departments,
          } as PendingEvidenceRecord['profiles'],
        };
        pendingRecords.push(typedRecord);
      }
    }

    return pendingRecords;
  }

  /**
   * Verifica si una inscripción tiene evidencia aprobada
   */
  private async checkApprovedEvidence(enrollmentId: string): Promise<boolean> {
    const count = await this.prisma.enrollment_evidences.count({
      where: {
        enrollment_id: enrollmentId,
        verification_status: 'approved',
        is_active: true,
      },
    });

    return count > 0;
  }

  /**
   * Calcula los días desde que terminó el curso
   */
  private calculateDaysPending(record: PendingEvidenceRecord): number {
    const endDate = record.course_editions?.end_date;
    if (!endDate) return 0;

    const end = new Date(endDate);
    const today = new Date();
    const diffTime = today.getTime() - end.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    return Math.max(0, diffDays);
  }

  /**
   * Envía recordatorio al colaborador
   */
  private async sendReminderEmail(
    record: PendingEvidenceRecord,
    daysPending: number,
    isFollowUp: boolean,
  ): Promise<void> {
    const profile = record.profiles;
    const course = record.course_editions?.courses;

    if (!profile?.email || !course) {
      this.logger.warn(`No se puede enviar recordatorio: falta email o curso para ${record.id}`);
      return;
    }

    const template = this.emailService.renderTemplate('evidence_reminder', {
      recipientName: profile.full_name,
      courseName: course.name,
      institutionName: course.institutions?.name,
      daysPending,
    });

    const result = await this.emailService.sendEmail({
      to: { email: profile.email, name: profile.full_name },
      subject: isFollowUp ? `⏰ URGENTE: ${template.subject}` : template.subject,
      body: template.body,
      isHtml: true,
    });

    if (result.success) {
      this.logger.debug(`📧 Recordatorio enviado a ${profile.email} para curso ${course.name}`);

      // Registrar el envío para evitar spam
      await this.logReminderSent(record.id, profile.id, isFollowUp ? 'followup' : 'first');
    }
  }

  /**
   * Envía escalamiento a RRHH
   */
  private async sendEscalationEmail(
    record: PendingEvidenceRecord,
    daysPending: number,
  ): Promise<void> {
    const profile = record.profiles;
    const course = record.course_editions?.courses;

    if (!course) return;

    // Obtener emails de admin_rh
    const admins = await this.prisma.profiles.findMany({
      where: { role: 'admin_rh', is_active: true },
      select: { email: true, full_name: true },
    });

    if (!admins || admins.length === 0) {
      this.logger.warn('No hay administradores de RRHH para escalar');
      return;
    }

    const template = this.emailService.renderTemplate('evidence_reminder_escalation', {
      recipientName: profile?.full_name || 'Colaborador',
      courseName: course.name,
      institutionName: course.institutions?.name,
      daysPending,
    });

    for (const admin of admins) {
      await this.emailService.sendEmail({
        to: { email: admin.email, name: admin.full_name || '' },
        subject: template.subject,
        body: template.body,
        isHtml: true,
      });
    }

    this.logger.log(`⚠️ Escalamiento enviado a ${admins.length} admin(s) de RRHH`);

    // Registrar escalamiento
    await this.logReminderSent(record.id, profile?.id || '', 'escalation');
  }

  /**
   * Registra el envío de un recordatorio (para evitar spam)
   */
  private async logReminderSent(
    enrollmentId: string,
    profileId: string,
    type: 'first' | 'followup' | 'escalation',
  ): Promise<void> {
    // Por ahora solo logueamos, pero se podría guardar en una tabla
    // para evitar enviar múltiples recordatorios el mismo día
    this.logger.debug(`Recordatorio registrado: ${type} para enrollment ${enrollmentId}`);
  }

  /**
   * Registra la ejecución del cron en auditoría
   */
  private async logReminderExecution(stats: {
    totalPending: number;
    firstReminders: number;
    followUpReminders: number;
    escalations: number;
  }): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: {
          action: 'create',
          entity_type: 'enrollment',
          entity_id: '00000000-0000-0000-0000-000000000000', // ID especial para sistema
          entity_name: 'reminder_execution',
          user_id: '00000000-0000-0000-0000-000000000000', // ID especial para sistema
          user_name: 'Sistema',
          user_role: 'system',
          description: `Ejecución de recordatorios: ${stats.totalPending} pendientes, ${stats.firstReminders} primeros, ${stats.followUpReminders} seguimientos, ${stats.escalations} escalamientos`,
          new_values: stats,
        } as any,
      });
    } catch (err) {
      // El user_id del sistema no es FK válido; logueamos pero no fallamos el cron.
      this.logger.warn(`No se pudo registrar audit_log de ejecución de recordatorios: ${(err as Error).message}`);
    }
  }

  /**
   * Método público para ejecutar verificación manualmente (para testing)
   */
  async runManualCheck(): Promise<{
    pending: number;
    processed: number;
  }> {
    this.logger.log('🔧 Ejecutando verificación manual de recordatorios...');
    await this.checkPendingEvidences();

    const pendingRecords = await this.getPendingEvidenceRecords();
    return {
      pending: pendingRecords.length,
      processed: pendingRecords.length,
    };
  }
}
