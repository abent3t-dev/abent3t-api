import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  ContractDigestItem,
  IEmailService,
  EmailTemplateType,
  EmailTemplateData,
} from './email.interfaces';
import {
  EmailOutboxService,
  type EnqueueEmailInput,
  type EnqueueResult,
} from './email-outbox.service';
import { EmailTransportService } from './email-transport.service';

/**
 * Texto seguro para plantillas: EmailTemplateData admite `unknown` en sus
 * campos extra, así que solo se interpolan primitivos ('' en cualquier otro
 * caso — nunca "[object Object]").
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/** Escapa texto para HTML (razones sociales con "&", servicios con "<"…). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** "1 contrato por vencer y 3 vencidos sin renovar" (asunto del resumen). */
export function contractDigestSubject(
  porVencer: number,
  vencidos: number,
): string {
  const parts = [
    porVencer > 0
      ? plural(porVencer, 'contrato por vencer', 'contratos por vencer')
      : null,
    vencidos > 0
      ? plural(vencidos, 'vencido sin renovar', 'vencidos sin renovar')
      : null,
  ].filter(Boolean);
  return `[ABENT 3T] Contratos: ${parts.join(' y ')}`;
}

/**
 * Servicio de correo electrónico: plantillas y ENCOLADO.
 *
 * J1 (hilo con César, 2026-10-01): nadie envía directo. `enqueue` registra
 * el correo en la cola (`email_outbox`) y el worker lo envía respetando el
 * ritmo, el tope diario, la pausa y el dominio permitido (ver
 * EmailOutboxService). El transporte (simulación por defecto, Graph o SMTP)
 * vive en EmailTransportService.
 */
@Injectable()
export class EmailService implements IEmailService {
  constructor(
    private readonly configService: ConfigService,
    private readonly outbox: EmailOutboxService,
    private readonly transport: EmailTransportService,
  ) {}

  /** Registra el correo en la cola (dentro de `tx` si se pasa). */
  enqueue(
    input: EnqueueEmailInput,
    tx?: Prisma.TransactionClient,
  ): Promise<EnqueueResult> {
    return this.outbox.enqueue(input, tx);
  }

  getProviderInfo(): { name: string; configured: boolean; mode: string } {
    const info = this.transport.info();
    const names: Record<string, string> = {
      simulacion: 'Simulación (no sale correo)',
      graph: 'Microsoft Graph',
      smtp: 'SMTP (relay)',
    };
    return {
      name: names[info.mode] ?? info.mode,
      configured: info.mode !== 'simulacion' && info.ready,
      mode: info.mode,
    };
  }

  /**
   * Renderiza una plantilla de correo
   */
  renderTemplate(
    template: EmailTemplateType,
    data: EmailTemplateData,
  ): { subject: string; body: string } {
    const baseUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';

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

      case 'contract_digest': {
        const porVencer = (data.porVencer ?? []) as ContractDigestItem[];
        const vencidos = (data.vencidos ?? []) as ContractDigestItem[];
        return {
          subject: contractDigestSubject(porVencer.length, vencidos.length),
          body: this.renderContractDigestTemplate(
            asText(data.recipientName),
            porVencer,
            vencidos,
            Number(data.thresholdDays) || 45,
            baseUrl,
          ),
        };
      }

      default:
        return {
          subject: 'Notificación de Capacitación',
          body: `Hola ${data.recipientName},\n\nTienes una notificación pendiente.\n\nSaludos,\nEquipo de Capacitación`,
        };
    }
  }

  /**
   * J2 (hilo con César, 2026-10-01) — UN resumen diario por persona con sus
   * contratos por vencer y los vencidos sin renovar, en lugar de un correo
   * por contrato. Enlace al portal (el detalle se abre en modal) y sin
   * adjuntos.
   */
  private renderContractDigestTemplate(
    recipientName: string,
    porVencer: ContractDigestItem[],
    vencidos: ContractDigestItem[],
    thresholdDays: number,
    baseUrl: string,
  ): string {
    const cell =
      'padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:left;';
    const head = `${cell}background:#f3f4f6;font-size:12px;color:#4b5563;`;
    const table = (
      items: ContractDigestItem[],
      when: (item: ContractDigestItem) => string,
    ) => `
      <table style="border-collapse:collapse;width:100%;font-size:13px;">
        <tr>
          <th style="${head}">Contrato</th>
          <th style="${head}">Proveedor</th>
          <th style="${head}">Servicio</th>
          <th style="${head}">Fin</th>
          <th style="${head}"></th>
        </tr>
        ${items
          .map(
            (item) => `
        <tr>
          <td style="${cell}white-space:nowrap;"><strong>${escapeHtml(item.contractNumber)}</strong></td>
          <td style="${cell}">${escapeHtml(item.supplierName)}</td>
          <td style="${cell}">${escapeHtml(item.serviceDescription)}</td>
          <td style="${cell}white-space:nowrap;">${escapeHtml(item.endDate)}</td>
          <td style="${cell}white-space:nowrap;">${when(item)}</td>
        </tr>`,
          )
          .join('')}
      </table>`;
    const sections = [
      porVencer.length > 0
        ? `<h3 style="margin:20px 0 8px;color:#2E7D1F;">Por vencer en los próximos ${thresholdDays} días (${porVencer.length})</h3>${table(
            porVencer,
            (item) =>
              item.daysLeft === 0
                ? 'vence hoy'
                : `en ${plural(item.daysLeft, 'día', 'días')}`,
          )}`
        : '',
      vencidos.length > 0
        ? `<h3 style="margin:20px 0 8px;color:#c0392b;">Vencidos sin renovar (${vencidos.length})</h3>${table(
            vencidos,
            (item) =>
              item.daysLeft === 0
                ? 'venció hoy'
                : `hace ${plural(-item.daysLeft, 'día', 'días')}`,
          )}`
        : '',
    ].join('');
    return `
<!DOCTYPE html>
<html>
<body style="font-family:'Segoe UI',Arial,sans-serif;line-height:1.5;color:#333;">
  <div style="max-width:720px;margin:0 auto;padding:20px;">
    <div style="background:#52AF32;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
      <h2 style="margin:0;">Resumen diario de contratos</h2>
    </div>
    <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;">
      <p>Estimado/a <strong>${escapeHtml(recipientName)}</strong>,</p>
      <p>Estos son los contratos que requieren atención hoy. Llega un solo correo al día mientras sigan por vencer o vencidos sin renovar.</p>
      ${sections}
      <p style="margin-top:20px;">
        <a href="${baseUrl}/compras/contratos" style="display:inline-block;background:#52AF32;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Ver contratos en el portal</a>
      </p>
      <p style="margin-top:20px;font-size:12px;color:#666;">Mensaje automático del sistema de compras ABENT 3T. Los contratos vencidos antes de la carga de la base no se incluyen; Compras puede reactivarlos si están en renovación.</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  private renderEvidenceReminderTemplate(
    data: EmailTemplateData,
    baseUrl: string,
  ): string {
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

  private renderEscalationTemplate(
    data: EmailTemplateData,
    baseUrl: string,
  ): string {
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

  private renderEnrollmentTemplate(
    data: EmailTemplateData,
    baseUrl: string,
  ): string {
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
