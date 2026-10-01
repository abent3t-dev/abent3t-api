import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
 *
 * Remitente fijo: `EMAIL_FROM` (o el `AZURE_EMAIL_FROM` de antes).
 * Las credenciales nunca se registran ni viajan en los errores.
 */

export type EmailTransportMode = 'simulacion' | 'graph';

export const EMAIL_TRANSPORT_MODES: readonly EmailTransportMode[] = [
  'simulacion',
  'graph',
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

@Injectable()
export class EmailTransportService {
  private readonly logger = new Logger('Email:transporte');
  private graphToken: { value: string; expiresAt: number } | null = null;

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
        : [];
    return { mode, from: this.from, ready: missing.length === 0, missing };
  }

  async deliver(email: OutgoingEmail): Promise<DeliveryResult> {
    const mode = this.mode;
    if (mode === 'graph') return this.sendGraph(email);
    this.logger.log(
      `Correo SIMULADO para ${email.to.email}: ${email.subject.slice(0, 120)}`,
    );
    return {
      status: 'simulado',
      transport: 'simulacion',
      messageId: `simulado-${Date.now()}`,
    };
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
