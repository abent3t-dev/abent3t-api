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
   * J1 (2026-10-01): encola el correo; el worker de la cola lo envía
   * (ritmo, tope diario, pausa y dominio permitido).
   */
  enqueue(input: {
    template: string;
    entityType?: string | null;
    entityId?: string | null;
    to: { email: string; name?: string | null };
    subject: string;
    body: string;
    isHtml?: boolean;
    at?: Date;
  }): Promise<{ status: 'pendiente' | 'rechazado' | 'duplicado'; key: string }>;

  /**
   * Obtiene información del transporte actual
   */
  getProviderInfo(): { name: string; configured: boolean; mode: string };
}

// Tipos de plantillas de correo
export type EmailTemplateType =
  | 'evidence_reminder' // Recordatorio de evidencia pendiente
  | 'evidence_reminder_escalation' // Escalamiento a RRHH
  | 'evidence_approved' // Evidencia aprobada
  | 'evidence_rejected' // Evidencia rechazada
  | 'enrollment_notification' // Notificación de inscripción
  | 'course_starting_soon' // Curso por iniciar
  | 'course_completed' // Curso completado
  | 'contract_digest'; // J2: resumen diario de contratos por persona

/** J2: un contrato dentro del resumen diario. */
export interface ContractDigestItem {
  contractNumber: string;
  supplierName: string;
  serviceDescription: string;
  /** YYYY-MM-DD */
  endDate: string;
  /** Días a la fecha de fin (0 o negativo = ya venció). */
  daysLeft: number;
}

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
