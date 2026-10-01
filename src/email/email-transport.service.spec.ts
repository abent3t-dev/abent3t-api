import { ConfigService } from '@nestjs/config';
import { EmailTransportService } from './email-transport.service';
import {
  startFakeSmtp,
  type FakeSmtpServer,
} from '../../test/fake-smtp-server';

/**
 * J1 (2026-10-01) — Transporte del correo. El default es SIMULACIÓN aunque
 * haya credenciales: un deploy no habilita el envío por accidente. Graph se
 * prueba con `fetch` falso (cero red).
 */

const AZURE = {
  AZURE_TENANT_ID: 'tenant-1',
  AZURE_CLIENT_ID: 'client-1',
  AZURE_CLIENT_SECRET: 'secreto-que-no-debe-salir',
};

const email = {
  to: { email: 'ingrid@abent3t.com', name: 'Ingrid' },
  subject: 'Contratos por vencer',
  body: '<p>Hola</p>',
  isHtml: true,
};

const make = (env: Record<string, string>) =>
  new EmailTransportService(new ConfigService(env));

function jsonResponse(status: number, body: unknown, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('transporte de correo (J1)', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('el default es simulación aunque haya credenciales de Azure', async () => {
    const transport = make({
      ...AZURE,
      AZURE_EMAIL_FROM: 'compras@abent3t.com',
    });
    expect(transport.mode).toBe('simulacion');

    const result = await transport.deliver(email);
    expect(result.status).toBe('simulado');
    expect(result.transport).toBe('simulacion');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un valor desconocido de EMAIL_TRANSPORT también simula', () => {
    expect(make({ EMAIL_TRANSPORT: 'sendgrid' }).mode).toBe('simulacion');
    expect(make({ EMAIL_TRANSPORT: ' GRAPH ' }).mode).toBe('graph');
  });

  it('el remitente es EMAIL_FROM, luego AZURE_EMAIL_FROM', () => {
    expect(make({}).from).toBe('noreply@abent3t.com');
    expect(make({ AZURE_EMAIL_FROM: 'a@abent3t.com' }).from).toBe(
      'a@abent3t.com',
    );
    expect(
      make({ AZURE_EMAIL_FROM: 'a@abent3t.com', EMAIL_FROM: 'b@abent3t.com' })
        .from,
    ).toBe('b@abent3t.com');
  });

  it('Graph sin credenciales no intenta enviar y dice qué falta', async () => {
    const transport = make({ EMAIL_TRANSPORT: 'graph', AZURE_TENANT_ID: 't' });
    expect(transport.info()).toMatchObject({
      mode: 'graph',
      ready: false,
      missing: ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'],
    });
    await expect(transport.deliver(email)).rejects.toThrow(
      'Faltan variables para Graph: AZURE_CLIENT_ID, AZURE_CLIENT_SECRET',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Graph envía con el token de la app y lo reutiliza', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('login.microsoftonline.com')
          ? jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 })
          : new Response(null, {
              status: 202,
              headers: { 'request-id': 'req-1' },
            }),
      ),
    );
    const transport = make({
      ...AZURE,
      EMAIL_TRANSPORT: 'graph',
      EMAIL_FROM: 'compras@abent3t.com',
    });

    const first = await transport.deliver(email);
    expect(first).toEqual({
      status: 'enviado',
      transport: 'graph',
      messageId: 'req-1',
    });
    await transport.deliver(email);

    const urls = fetchMock.mock.calls.map((c: [string]) => c[0]);
    expect(urls.filter((u) => u.includes('oauth2'))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('/sendMail'))).toEqual([
      'https://graph.microsoft.com/v1.0/users/compras%40abent3t.com/sendMail',
      'https://graph.microsoft.com/v1.0/users/compras%40abent3t.com/sendMail',
    ]);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok-1',
    );
    const payload = JSON.parse(init.body as string) as {
      message: { toRecipients: Array<{ emailAddress: { address: string } }> };
    };
    expect(payload.message.toRecipients[0].emailAddress.address).toBe(
      'ingrid@abent3t.com',
    );
  });

  it('si Graph no responde 202, falla sin exponer el secreto', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('login.microsoftonline.com')
          ? jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 })
          : jsonResponse(403, { error: { code: 'ErrorAccessDenied' } }),
      ),
    );
    const transport = make({ ...AZURE, EMAIL_TRANSPORT: 'graph' });

    const error = await transport.deliver(email).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('403');
    expect((error as Error).message).not.toContain(AZURE.AZURE_CLIENT_SECRET);
  });
});

/**
 * J3 (2026-10-01) — Relay SMTP con un servidor SMTP FALSO local (127.0.0.1,
 * puerto libre): se prueba el protocolo de verdad sin salir a la red.
 */
describe('transporte SMTP (J3)', () => {
  let smtp: FakeSmtpServer | null = null;

  afterEach(async () => {
    await smtp?.close();
    smtp = null;
  });

  const smtpEnv = (port: number, extra: Record<string, string> = {}) => ({
    EMAIL_TRANSPORT: 'smtp',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(port),
    EMAIL_FROM: 'avisos@abent3t.com',
    ...extra,
  });

  it('envía por el relay con el remitente fijo', async () => {
    smtp = await startFakeSmtp();
    const transport = make(smtpEnv(smtp.port));
    expect(transport.info()).toMatchObject({
      mode: 'smtp',
      from: 'avisos@abent3t.com',
      ready: true,
      missing: [],
    });

    const result = await transport.deliver(email);
    expect(result.status).toBe('enviado');
    expect(result.transport).toBe('smtp');
    expect(result.messageId).toMatch(/^<.+>$/);

    expect(smtp.messages).toHaveLength(1);
    const [message] = smtp.messages;
    expect(message.from).toBe('avisos@abent3t.com');
    expect(message.to).toEqual(['ingrid@abent3t.com']);
    expect(message.data).toContain('Subject: Contratos por vencer');
    expect(message.data).toContain('text/html');
    expect(message.data).toContain('<p>Hola</p>');
  });

  it('el texto plano sale como text/plain', async () => {
    smtp = await startFakeSmtp();
    await make(smtpEnv(smtp.port)).deliver({
      ...email,
      body: 'Hola en texto',
      isHtml: false,
    });
    expect(smtp.messages[0].data).toContain('text/plain');
    expect(smtp.messages[0].data).toContain('Hola en texto');
  });

  it('con usuario exige STARTTLS: sin TLS falla y la contraseña nunca sale', async () => {
    smtp = await startFakeSmtp();
    const transport = make(
      smtpEnv(smtp.port, {
        SMTP_USER: 'relay-user',
        SMTP_PASS: 'secreto-smtp',
      }),
    );
    expect(transport.smtpOptions()).toMatchObject({
      secure: false,
      requireTLS: true,
      auth: { user: 'relay-user' },
      tls: { minVersion: 'TLSv1.2' },
    });

    const error = await transport.deliver(email).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('STARTTLS');
    expect((error as Error).message).not.toContain('secreto-smtp');
    // Se detiene al no poder cifrar: nunca llega a AUTH
    expect(smtp.commands.map((c) => c.split(' ')[0])).toEqual([
      'EHLO',
      'STARTTLS',
    ]);
    expect(smtp.commands.join('\n')).not.toContain(
      Buffer.from('secreto-smtp').toString('base64'),
    );
    expect(smtp.messages).toHaveLength(0);
  });

  it('un destinatario rechazado por el relay es error (la cola reintenta)', async () => {
    smtp = await startFakeSmtp({ rejectRecipients: true });
    await expect(make(smtpEnv(smtp.port)).deliver(email)).rejects.toThrow(
      /SMTP respondió 550/,
    );
    expect(smtp.messages).toHaveLength(0);
  });

  it('SMTP_SECURE=true es TLS desde el inicio; el puerto default es 587', () => {
    expect(
      make(smtpEnv(465, { SMTP_SECURE: 'true' })).smtpOptions(),
    ).toMatchObject({ port: 465, secure: true, requireTLS: false });
    expect(
      make({ EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'relay' }).smtpOptions(),
    ).toMatchObject({ port: 587, secure: false });
  });

  it('sin SMTP_HOST ni EMAIL_FROM no intenta enviar y dice qué falta', async () => {
    const transport = make({ EMAIL_TRANSPORT: 'smtp', SMTP_USER: 'u' });
    expect(transport.info()).toMatchObject({
      ready: false,
      missing: ['SMTP_HOST', 'EMAIL_FROM', 'SMTP_PASS'],
    });
    await expect(transport.deliver(email)).rejects.toThrow(
      'Faltan variables para SMTP: SMTP_HOST, EMAIL_FROM, SMTP_PASS',
    );
  });
});
