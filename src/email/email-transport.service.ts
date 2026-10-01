import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createTransport,
  type Mail,
  type SMTPSentMessageInfo,
  type SMTPTransportOptions,
} from 'nodemailer';

/**
 * J1 (hilo con César, 2026-10-01) — Transporte del correo: lo usa SOLO el
 * worker de la cola (EmailOutboxService); nadie más envía directo.
 *
 * `EMAIL_TRANSPORT` decide a dónde sale:
 *  - `simulacion` (DEFAULT): no sale nada; el correo queda "simulado" en la
 *    bitácora. Así un deploy nunca habilita el envío por accidente, aunque
 *    haya credenciales AZURE_* en el entorno.
 *  - `graph`: Microsoft Graph `/users/{from}/sendMail` con client credentials
 *    (requiere Mail.Send en Entra y AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET).
 *  - `smtp` (J3, 2026-10-01): relay SMTP tipo Doppler Relay con nodemailer
 *    (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE); así la app no
 *    necesita Mail.Send en Entra. Con usuario y sin TLS implícito se EXIGE
 *    STARTTLS: la contraseña nunca viaja en claro. TLS 1.2 como mínimo.
 *
 * Remitente fijo: `EMAIL_FROM` (o el `AZURE_EMAIL_FROM` de antes; con SMTP,
 * `EMAIL_FROM` es obligatorio: el dominio autorizado en el relay).
 * Las credenciales nunca se registran ni viajan en los errores.
 */

export type EmailTransportMode = 'simulacion' | 'graph' | 'smtp';

export const EMAIL_TRANSPORT_MODES: readonly EmailTransportMode[] = [
  'simulacion',
  'graph',
  'smtp',
];

export interface OutgoingEmail {
  to: { email: string; name?: string | null };
  subject: string;
  body: string;
  isHtml: boolean;
}

export interface DeliveryResult {
  status: 'enviado' | 'simulado';
  transport: EmailTransportMode;
  messageId: string;
}

export interface EmailTransportInfo {
  mode: EmailTransportMode;
  from: string;
  /** Tiene lo necesario para enviar de verdad (en simulación, siempre). */
  ready: boolean;
  /** Variables que faltan para el modo elegido. */
  missing: string[];
}

const GRAPH_TIMEOUT_MS = 15_000;
const SMTP_TIMEOUT_MS = 15_000;
export const DEFAULT_SMTP_PORT = 587;

@Injectable()
export class EmailTransportService {
  private readonly logger = new Logger('Email:transporte');
  private graphToken: { value: string; expiresAt: number } | null = null;
  private smtp: Mail<SMTPSentMessageInfo, SMTPTransportOptions> | null = null;

  constructor(private readonly config: ConfigService) {}

  get mode(): EmailTransportMode {
    const raw = (this.config.get<string>('EMAIL_TRANSPORT') ?? '')
      .trim()
      .toLowerCase();
    return (EMAIL_TRANSPORT_MODES as readonly string[]).includes(raw)
      ? (raw as EmailTransportMode)
      : 'simulacion';
  }

  get from(): string {
    return (
      this.config.get<string>('EMAIL_FROM') ||
      this.config.get<string>('AZURE_EMAIL_FROM') ||
      'noreply@abent3t.com'
    );
  }

  info(): EmailTransportInfo {
    const mode = this.mode;
    const missing =
      mode === 'graph'
        ? ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'].filter(
            (name) => !this.config.get<string>(name),
          )
        : mode === 'smtp'
          ? this.smtpMissing()
          : [];
    return { mode, from: this.from, ready: missing.length === 0, missing };
  }

  async deliver(email: OutgoingEmail): Promise<DeliveryResult> {
    const mode = this.mode;
    if (mode === 'graph') return this.sendGraph(email);
    if (mode === 'smtp') return this.sendSmtp(email);
    this.logger.log(
      `Correo SIMULADO para ${email.to.email}: ${email.subject.slice(0, 120)}`,
    );
    return {
      status: 'simulado',
      transport: 'simulacion',
      messageId: `simulado-${Date.now()}`,
    };
  }

  // ── SMTP (J3) ───────────────────────────────────────────────────────────

  /** Opciones del relay; con usuario, la conexión va cifrada sí o sí. */
  smtpOptions(): SMTPTransportOptions {
    const secure = this.flag('SMTP_SECURE');
    const user = this.config.get<string>('SMTP_USER') || '';
    const pass = this.config.get<string>('SMTP_PASS') || '';
    const port = Number(this.config.get<string | number>('SMTP_PORT'));
    return {
      host: this.config.get<string>('SMTP_HOST'),
      port: Number.isInteger(port) && port > 0 ? port : DEFAULT_SMTP_PORT,
      // true = TLS desde el inicio (465); false = STARTTLS (587)
      secure,
      requireTLS: !secure && user !== '',
      ...(user ? { auth: { user, pass } } : {}),
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS * 2,
    };
  }

  private smtpMissing(): string[] {
    const has = (name: string) => !!this.config.get<string>(name);
    const missing: string[] = [];
    if (!has('SMTP_HOST')) missing.push('SMTP_HOST');
    if (!has('EMAIL_FROM')) missing.push('EMAIL_FROM');
    if (has('SMTP_USER') && !has('SMTP_PASS')) missing.push('SMTP_PASS');
    if (has('SMTP_PASS') && !has('SMTP_USER')) missing.push('SMTP_USER');
    return missing;
  }

  private async sendSmtp(email: OutgoingEmail): Promise<DeliveryResult> {
    const info = this.info();
    if (!info.ready) {
      throw new Error(`Faltan variables para SMTP: ${info.missing.join(', ')}`);
    }
    this.smtp ??= createTransport(this.smtpOptions());
    let sent: SMTPSentMessageInfo;
    try {
      sent = await this.smtp.sendMail({
        from: this.from,
        to: email.to.name
          ? { name: email.to.name, address: email.to.email }
          : email.to.email,
        subject: email.subject,
        ...(email.isHtml ? { html: email.body } : { text: email.body }),
      });
    } catch (err: unknown) {
      // nodemailer no pone la contraseña en el error; se recorta igual
      const e = err as {
        message?: string;
        code?: string;
        responseCode?: number;
      };
      throw new Error(
        `SMTP respondió ${e.responseCode ?? e.code ?? 'error'}: ${(e.message ?? '').slice(0, 200)}`,
      );
    }
    if (sent.rejected.length > 0) {
      throw new Error(`SMTP rechazó el destinatario: ${sent.response}`);
    }
    this.logger.log(
      `Correo enviado por SMTP a ${email.to.email}: ${email.subject.slice(0, 120)}`,
    );
    return { status: 'enviado', transport: 'smtp', messageId: sent.messageId };
  }

  /** Booleano de entorno: Joi ya lo convierte; en pruebas llega como texto. */
  private flag(name: string): boolean {
    const raw = this.config.get<string | boolean>(name);
    return (
      raw === true ||
      String(raw ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

  // ── Microsoft Graph ─────────────────────────────────────────────────────

  private async sendGraph(email: OutgoingEmail): Promise<DeliveryResult> {
    const info = this.info();
    if (!info.ready) {
      throw new Error(
        `Faltan variables para Graph: ${info.missing.join(', ')}`,
      );
    }
    const token = await this.graphAccessToken();
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.from)}/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            subject: email.subject,
            body: {
              contentType: email.isHtml ? 'HTML' : 'Text',
              content: email.body,
            },
            toRecipients: [
              {
                emailAddress: {
                  address: email.to.email,
                  ...(email.to.name ? { name: email.to.name } : {}),
                },
              },
            ],
          },
          saveToSentItems: true,
        }),
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      },
    );
    if (response.status !== 202) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      if (response.status === 401) this.graphToken = null;
      throw new Error(`Graph sendMail respondió ${response.status}: ${detail}`);
    }
    return {
      status: 'enviado',
      transport: 'graph',
      messageId:
        response.headers.get('request-id') ??
        response.headers.get('client-request-id') ??
        `graph-${Date.now()}`,
    };
  }

  /** Token de la app (client credentials), en caché hasta 1 min antes de vencer. */
  private async graphAccessToken(): Promise<string> {
    if (this.graphToken && this.graphToken.expiresAt > Date.now() + 60_000) {
      return this.graphToken.value;
    }
    const tenant = this.config.get<string>('AZURE_TENANT_ID') as string;
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.get<string>('AZURE_CLIENT_ID') as string,
          client_secret: this.config.get<string>(
            'AZURE_CLIENT_SECRET',
          ) as string,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }),
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      // El cuerpo de error de Entra no trae el secreto; se recorta igual
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`Token de Graph respondió ${response.status}: ${detail}`);
    }
    const json = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.graphToken = {
      value: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return json.access_token;
  }
}
