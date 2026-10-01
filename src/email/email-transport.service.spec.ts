import { ConfigService } from '@nestjs/config';
import { EmailTransportService } from './email-transport.service';

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
