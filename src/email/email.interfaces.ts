/**
 * Interfaz para el servicio de correo electrónico.
 * Diseñada para ser implementada con Microsoft Graph API / Azure AD
 * cuando las credenciales estén disponibles.
 */

export interface EmailRecipient {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  contentType: string;
}

export interface SendEmailOptions {
  to: EmailRecipient | EmailRecipient[];
  cc?: EmailRecipient | EmailRecipient[];
  bcc?: EmailRecipient | EmailRecipient[];
  subject: string;
  body: string;
  isHtml?: boolean;
  attachments?: EmailAttachment[];
  replyTo?: string;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface IEmailService {
  /**
   * Envía un correo electrónico
   */
  sendEmail(options: SendEmailOptions): Promise<SendEmailResult>;

  /**
   * Verifica si el servicio está configurado y disponible
   */
  isConfigured(): boolean;

  /**
   * Obtiene información del proveedor actual
   */
  getProviderInfo(): { name: string; configured: boolean };
}

// Tipos de plantillas de correo
export type EmailTemplateType =
  | 'evidence_reminder'           // Recordatorio de evidencia pendiente
  | 'evidence_reminder_escalation' // Escalamiento a RRHH
  | 'evidence_approved'           // Evidencia aprobada
  | 'evidence_rejected'           // Evidencia rechazada
  | 'enrollment_notification'     // Notificación de inscripción
  | 'course_starting_soon'        // Curso por iniciar
  | 'course_completed';           // Curso completado

export interface EmailTemplateData {
  recipientName: string;
  courseName?: string;
  institutionName?: string;
  dueDate?: string;
  daysPending?: number;
  reason?: string;
  actionUrl?: string;
  [key: string]: unknown;
}
