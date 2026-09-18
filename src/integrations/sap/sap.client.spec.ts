import { SapClient } from './sap.client';
import { SapSessionManager } from './sap-session.manager';
import { IntegrationAuthError, IntegrationHttpClientFactory } from '../common';
import type { SapConfig } from './sap.config';
import { SapNotConfiguredError, SapResponseShapeError } from './sap.errors';

/**
 * Fase INT-4. Cliente SAP con HTTP y sesión mockeados — sin red. Cubre: la
 * construcción del path OData (select por entidad, %20 en el filtro), la
 * cookie de sesión por llamada, el re-login + reintento ÚNICO ante 401 y
 * el parseo de /$count.
 */

const CONFIG: SapConfig = {
  baseUrl: 'https://sap.test:50000/b1s/v2',
  companyDb: 'TEST_DB',
  user: 'usuario',
  password: 'secreto',
  rejectUnauthorized: false,
  timeoutMs: 1_000,
  maxRetries: 0,
};

interface GetCall {
  path: string;
  options: { headers?: Record<string, string>; parseAs?: string };
}

function makeClient(config: Partial<SapConfig> = {}) {
  const calls: GetCall[] = [];
  let responses: Array<() => unknown> = [];
  const httpGet = jest.fn((path: string, options: GetCall['options']) => {
    calls.push({ path, options });
    const next = responses.shift();
    if (!next) throw new Error('sin respuesta programada');
    const result = next();
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({
      data: result,
      status: 200,
      headers: {},
      setCookie: [],
      url: path,
      durationMs: 5,
      attempts: 1,
    });
  });
  const factory = {
    create: jest.fn(() => ({ get: httpGet })),
  } as unknown as IntegrationHttpClientFactory;

  let cookieSeq = 0;
  const session = {
    missingConfig: jest.fn(() => {
      const missing: string[] = [];
      const merged = { ...CONFIG, ...config };
      if (!merged.baseUrl) missing.push('SL_BASE_URL');
      if (!merged.user) missing.push('SL_USER');
      return missing;
    }),
    getCookieHeader: jest.fn(() =>
      Promise.resolve(`B1SESSION=s${++cookieSeq}`),
    ),
    invalidate: jest.fn(),
  };

  const client = new SapClient(
    factory,
    { ...CONFIG, ...config },
    session as unknown as SapSessionManager,
    { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  );
  return {
    client,
    calls,
    session,
    program: (...r: Array<() => unknown>) => (responses = r),
  };
}

const okPage = (n: number) => () => ({
  value: Array.from({ length: n }, (_, i) => ({
    DocEntry: i + 1,
    DocumentLines: [],
  })),
});

describe('SapClient — construcción de peticiones', () => {
  it('PO: select completo + orderby/top/skip; la cookie de sesión viaja por header', async () => {
    const h = makeClient();
    h.program(okPage(2));
    const result = await h.client.fetchPurchaseOrders({ top: 20, skip: 40 });
    expect(result.records).toHaveLength(2);
    expect(result.raw).toHaveLength(2);
    const call = h.calls[0];
    expect(call.path).toContain('PurchaseOrders?$select=');
    expect(call.path).toContain('CardName');
    expect(call.path).toContain('DocumentLines');
    expect(call.path).toContain('$orderby=DocEntry&$top=20&$skip=40');
    expect(call.path).not.toContain('$expand'); // HTTP 400 en este SL
    expect(call.options.headers?.Cookie).toBe('B1SESSION=s1');
  });

  it('PR: select SIN CardCode/CardName/DocTotal (el SL los rechaza) y CON Requester', async () => {
    const h = makeClient();
    h.program(okPage(1));
    await h.client.fetchPurchaseRequests({ top: 5, skip: 0 });
    const path = h.calls[0].path;
    expect(path).toContain('PurchaseRequests?$select=');
    expect(path).toContain('Requester,RequesterName');
    expect(path).toContain('RequriedDate'); // sic
    expect(path).not.toContain('CardCode');
    expect(path).not.toContain('DocTotal');
  });

  it('incremental: $filter=UpdateDate ge YYYY-MM-DD con espacios %20 (no "+")', async () => {
    const h = makeClient();
    h.program(okPage(0));
    await h.client.fetchPurchaseOrders({
      top: 20,
      skip: 0,
      updatedSince: new Date(Date.UTC(2026, 8, 1)),
    });
    expect(h.calls[0].path).toContain('$filter=UpdateDate%20ge%202026-09-01');
    expect(h.calls[0].path).not.toContain('+');
  });

  it('respuesta sin `value` → SapResponseShapeError', async () => {
    const h = makeClient();
    h.program(() => ({ otra: 'cosa' }));
    await expect(
      h.client.fetchPurchaseOrders({ top: 20, skip: 0 }),
    ).rejects.toThrow(SapResponseShapeError);
  });

  it('sin configuración → SapNotConfiguredError sin llamar al factory', async () => {
    const h = makeClient({ baseUrl: null, user: null });
    await expect(
      h.client.fetchPurchaseOrders({ top: 20, skip: 0 }),
    ).rejects.toThrow(SapNotConfiguredError);
  });
});

describe('SapClient — sesión expirada (401)', () => {
  const authError = () =>
    new IntegrationAuthError({
      system: 'sap',
      url: 'https://sap.test/x',
      attempt: 1,
      status: 401,
      body: '',
    });

  it('401 → invalidate(cookie que falló) + re-login + reintento único que triunfa', async () => {
    const h = makeClient();
    h.program(() => authError(), okPage(1));
    const result = await h.client.fetchPurchaseOrders({ top: 20, skip: 0 });
    expect(result.records).toHaveLength(1);
    expect(h.session.invalidate).toHaveBeenCalledTimes(1);
    expect(h.session.invalidate).toHaveBeenCalledWith('B1SESSION=s1');
    // segunda llamada con cookie fresca
    expect(h.calls[1].options.headers?.Cookie).toBe('B1SESSION=s2');
  });

  it('403 (permisos) NO dispara re-login: se propaga a la primera', async () => {
    const h = makeClient();
    h.program(
      () =>
        new IntegrationAuthError({
          system: 'sap',
          url: 'https://sap.test/x',
          attempt: 1,
          status: 403,
          body: '',
        }),
    );
    await expect(
      h.client.fetchPurchaseOrders({ top: 20, skip: 0 }),
    ).rejects.toThrow(IntegrationAuthError);
    expect(h.session.invalidate).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
  });

  it('401 persistente tras el re-login se propaga (sin bucle)', async () => {
    const h = makeClient();
    h.program(
      () => authError(),
      () => authError(),
    );
    await expect(
      h.client.fetchPurchaseOrders({ top: 20, skip: 0 }),
    ).rejects.toThrow(IntegrationAuthError);
    expect(h.calls).toHaveLength(2); // exactamente un reintento
  });
});

describe('SapClient — /$count', () => {
  it('parsea el entero (parseAs text) y acepta filtro incremental', async () => {
    const h = makeClient();
    h.program(
      () => '3358',
      () => '159',
    );
    await expect(h.client.countPurchaseOrders()).resolves.toBe(3358);
    await expect(
      h.client.countPurchaseOrders(new Date(Date.UTC(2026, 7, 1))),
    ).resolves.toBe(159);
    expect(h.calls[0].path).toBe('PurchaseOrders/$count');
    expect(h.calls[0].options.parseAs).toBe('text');
    expect(h.calls[1].path).toBe(
      'PurchaseOrders/$count?$filter=UpdateDate%20ge%202026-08-01',
    );
  });

  it('cuerpo no numérico → SapResponseShapeError', async () => {
    const h = makeClient();
    h.program(() => 'no-un-numero');
    await expect(h.client.countPurchaseRequests()).rejects.toThrow(
      SapResponseShapeError,
    );
  });
});
