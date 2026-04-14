import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IEmailService,
  SendEmailOptions,
  SendEmailResult,
  EmailTemplateType,
  EmailTemplateData,
} from './email.interfaces';

/**
 * Servicio de correo electrónico.
 *
 * ESTADO ACTUAL: Modo simulación (logging)
 *
 * TODO: Implementar con Microsoft Graph API cuando las credenciales
 * de Azure AD estén disponibles:
 *
 * 1. Instalar: npm install @azure/identity @microsoft/microsoft-graph-client
 * 2. Configurar variables de entorno:
 *    - AZURE_TENANT_ID
 *    - AZURE_CLIENT_ID
 *    - AZURE_CLIENT_SECRET
 *    - AZURE_EMAIL_FROM (email del remitente)
 * 3. Descomentar el código de Microsoft Graph en sendEmail()
 */
@Injectable()
export class EmailService implements IEmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly isConfiguredFlag: boolean;
  private readonly emailFrom: string;

  constructor(private readonly configService: ConfigService) {
    // Verificar si Microsoft/Azure está configurado
    const tenantId = this.configService.get<string>('AZURE_TENANT_ID');
    const clientId = this.configService.get<string>('AZURE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('AZURE_CLIENT_SECRET');
    this.emailFrom = this.configService.get<string>('AZURE_EMAIL_FROM') || 'noreply@abent3t.com';

    this.isConfiguredFlag = !!(tenantId && clientId && clientSecret);

    if (this.isConfiguredFlag) {
      this.logger.log('✉️ Servicio de email configurado con Microsoft Graph');
    } else {
      this.logger.warn(
        '⚠️ Servicio de email en MODO SIMULACIÓN. ' +
        'Configure AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET para habilitar envío real.',
      );
    }
  }

  isConfigured(): boolean {
    return this.isConfiguredFlag;
  }

  getProviderInfo(): { name: string; configured: boolean } {
    return {
      name: 'Microsoft Graph / Azure AD',
      configured: this.isConfiguredFlag,
    };
  }

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const recipients = Array.isArray(options.to) ? options.to : [options.to];
    const recipientEmails = recipients.map((r) => r.email).join(', ');

    // Si no está configurado, solo logueamos
    if (!this.isConfiguredFlag) {
      this.logger.log('─────────────────────────────────────────────');
      this.logger.log('📧 EMAIL SIMULADO (Microsoft Graph no configurado)');
      this.logger.log(`   Para: ${recipientEmails}`);
      this.logger.log(`   Asunto: ${options.subject}`);
      this.logger.log(`   Cuerpo: ${options.body.substring(0, 200)}...`);
      this.logger.log('─────────────────────────────────────────────');

      return {
        success: true,
        messageId: `simulated-${Date.now()}`,
      };
    }

    // TODO: Implementar envío real con Microsoft Graph
    // Cuando las credenciales estén disponibles, descomentar:
    /*
    try {
      const { ClientSecretCredential } = await import('@azure/identity');
      const { Client } = await import('@microsoft/microsoft-graph-client');
      const { TokenCredentialAuthenticationProvider } = await import(
        '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials'
      );

      const credential = new ClientSecretCredential(
        this.configService.get('AZURE_TENANT_ID'),
        this.configService.get('AZURE_CLIENT_ID'),
        this.configService.get('AZURE_CLIENT_SECRET'),
      );

      const authProvider = new TokenCredentialAuthenticationProvider(credential, {
        scopes: ['https://graph.microsoft.com/.default'],
      });

      const client = Client.initWithMiddleware({ authProvider });

      const message = {
        subject: options.subject,
        body: {
          contentType: options.isHtml ? 'HTML' : 'Text',
          content: options.body,
        },
        toRecipients: recipients.map((r) => ({
          emailAddress: { address: r.email, name: r.name },
        })),
      };

      await client.api(`/users/${this.emailFrom}/sendMail`).post({ message });

      return { success: true, messageId: `ms-${Date.now()}` };
    } catch (error) {
      this.logger.error('Error enviando email con Microsoft Graph:', error);
      return { success: false, error: error.message };
    }
    */

    // Por ahora, retornamos simulación
    this.logger.log(`📧 Email enviado (simulado) a: ${recipientEmails}`);
    return {
      success: true,
      messageId: `simulated-${Date.now()}`,
    };
  }

  /**
   * Renderiza una plantilla de correo
   */
  renderTemplate(template: EmailTemplateType, data: EmailTemplateData): { subject: string; body: string } {
    const baseUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';

    switch (template) {
      case 'evidence_reminder':
        return {
          subject: `Recordatorio: Evidencia pendiente - ${data.courseName}`,
          body: this.renderEvidenceReminderTemplate(data, baseUrl),
        };

      case 'evidence_reminder_escalation':
        return {
          subject: `⚠️ Escalamiento: Evidencia pendiente de ${data.recipientName}`,
          body: this.renderEscalationTemplate(data, baseUrl),
        };

      case 'evidence_approved':
        return {
          subject: `✅ Evidencia aprobada - ${data.courseName}`,
          body: this.renderEvidenceApprovedTemplate(data),
        };

      case 'evidence_rejected':
        return {
          subject: `Evidencia rechazada - ${data.courseName}`,
          body: this.renderEvidenceRejectedTemplate(data),
        };

      case 'enrollment_notification':
        return {
          subject: `Nueva inscripción: ${data.courseName}`,
          body: this.renderEnrollmentTemplate(data, baseUrl),
        };

      default:
        return {
          subject: 'Notificación de Capacitación',
          body: `Hola ${data.recipientName},\n\nTienes una notificación pendiente.\n\nSaludos,\nEquipo de Capacitación`,
        };
    }
  }

  private renderEvidenceReminderTemplate(data: EmailTemplateData, baseUrl: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #52AF32, #67B52E); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9f9f9; padding: 20px; border-radius: 0 0 8px 8px; }
    .btn { display: inline-block; background: #52AF32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 15px; }
    .footer { margin-top: 20px; font-size: 12px; color: #666; }
    .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 10px; margin: 15px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>📋 Recordatorio de Evidencia</h2>
    </div>
    <div class="content">
      <p>Hola <strong>${data.recipientName}</strong>,</p>

      <p>Te recordamos que tienes pendiente subir la evidencia (certificado, diploma, etc.)
      del siguiente curso:</p>

      <div class="warning">
        <strong>📚 ${data.courseName}</strong><br>
        ${data.institutionName ? `🏛️ ${data.institutionName}` : ''}
        ${data.daysPending ? `<br>⏰ Días pendientes: <strong>${data.daysPending}</strong>` : ''}
      </div>

      <p>Por favor, sube tu evidencia lo antes posible para que podamos registrar
      tu capacitación como completada.</p>

      <a href="${baseUrl}/capacitacion/mis-cursos" class="btn">
        Subir Evidencia
      </a>

      <div class="footer">
        <p>Este es un mensaje automático del sistema de capacitación ABENT 3T.</p>
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  private renderEscalationTemplate(data: EmailTemplateData, baseUrl: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #dc3545, #c82333); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9f9f9; padding: 20px; border-radius: 0 0 8px 8px; }
    .btn { display: inline-block; background: #dc3545; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 15px; }
    .footer { margin-top: 20px; font-size: 12px; color: #666; }
    .alert { background: #f8d7da; border-left: 4px solid #dc3545; padding: 10px; margin: 15px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>⚠️ Escalamiento: Evidencia Pendiente</h2>
    </div>
    <div class="content">
      <p>Estimado equipo de RRHH,</p>

      <p>El siguiente colaborador tiene evidencia pendiente por más de
      <strong>${data.daysPending} días</strong>:</p>

      <div class="alert">
        <strong>👤 Colaborador:</strong> ${data.recipientName}<br>
        <strong>📚 Curso:</strong> ${data.courseName}<br>
        ${data.institutionName ? `<strong>🏛️ Institución:</strong> ${data.institutionName}<br>` : ''}
        <strong>⏰ Días pendientes:</strong> ${data.daysPending}
      </div>

      <p>Se recomienda dar seguimiento al colaborador para completar la documentación.</p>

      <a href="${baseUrl}/capacitacion/evidencias" class="btn">
        Ver Evidencias Pendientes
      </a>

      <div class="footer">
        <p>Este es un mensaje automático del sistema de capacitación ABENT 3T.</p>
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  private renderEvidenceApprovedTemplate(data: EmailTemplateData): string {
    return `
Hola ${data.recipientName},

¡Buenas noticias! Tu evidencia para el curso "${data.courseName}" ha sido aprobada.

Tu capacitación ha sido registrada correctamente en el sistema.

Saludos,
Equipo de Capacitación ABENT 3T
    `.trim();
  }

  private renderEvidenceRejectedTemplate(data: EmailTemplateData): string {
    return `
Hola ${data.recipientName},

Lamentablemente, tu evidencia para el curso "${data.courseName}" ha sido rechazada.

${data.reason ? `Motivo: ${data.reason}` : ''}

Por favor, sube una nueva evidencia que cumpla con los requisitos.

Saludos,
Equipo de Capacitación ABENT 3T
    `.trim();
  }

  private renderEnrollmentTemplate(data: EmailTemplateData, baseUrl: string): string {
    return `
Hola ${data.recipientName},

Has sido inscrito en el siguiente curso:

📚 ${data.courseName}
${data.institutionName ? `🏛️ ${data.institutionName}` : ''}

Puedes ver los detalles en: ${baseUrl}/capacitacion/mis-cursos

Saludos,
Equipo de Capacitación ABENT 3T
    `.trim();
  }
}
