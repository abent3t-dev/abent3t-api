import { inspect } from 'util';
import {
  IntegrationAuthError,
  IntegrationError,
  IntegrationNetworkError,
  IntegrationRequestError,
  IntegrationServerError,
  IntegrationTimeoutError,
} from '../errors/integration.errors';
import { LoggerLike, REDACTED } from '../logging/integration-logger';
import { IntegrationHttpClient } from './integration-http.client';
import { IntegrationHttpClientFactory } from './integration-http-client.factory';
import {
  FetchLike,
  INTEGRATION_HTTP_DEFAULTS,
  IntegrationHttpClientConfig,
} from './integration-http.types';

/**
 * Fase INT-1. Todos los tests usan un `fetchImpl` inyectado: NINGUNO toca la
 * red. Los tokens/credenciales que aparecen son cadenas ficticias de test.
 */

const FAKE_TOKEN = 'bWF4YWRtaW46ZmFrZS1wYXNzd29yZA=='; // ficticio
const BASE_URL = 'http://maximo.test:9080/maxrest/rest/os';

type FetchCall = Parameters<FetchLike>;

/** Construye una Response como la que devolvería undici. */
function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

/** Respuesta cuyas cabeceras llegan pero cuyo cuerpo nunca termina. */
function stalledBodyResponse(status = 200): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    status,
  });
}

/** Respuesta cuyo cuerpo falla a mitad de lectura (socket cortado). */
function brokenBodyResponse(status: number, err: Error): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        controller.error(err);
      },
    }),
    { status },
  );
}

/** Error tal como lo lanza undici ante un fallo de socket. */
function networkError(code: string, message = 'fetch failed'): Error {
  const err = new TypeError(message);
  (err as Error & { cause: { code: string } }).cause = { code };
  return err;
}

interface Harness {
  client: IntegrationHttpClient;
  fetchMock: jest.Mock<Promise<Response>, FetchCall>;
  sleeps: number[];
  lines: string[];
}

type Scripted = Response | Error | 'hang' | (() => Response);

/**
 * `fetchMock` se alimenta con una cola de respuestas/errores; `sleep` no
 * espera (solo registra); `random` fijo hace el backoff determinista.
 */
function makeClient(
  queue: Scripted[],
  overrides: Partial<IntegrationHttpClientConfig> = {},
): Harness {
  const sleeps: number[] = [];
  const lines: string[] = [];
  const logger: LoggerLike = {
    log: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m),
    debug: (m) => lines.push(m),
  };

  const fetchMock = jest.fn<Promise<Response>, FetchCall>((_url, init) => {
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('fetchMock: cola vacía'));
    }
    if (next === 'hang') {
      // Simula un servidor que nunca responde: solo termina si abortan.
      return new Promise<Response>((_, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    if (next instanceof Error) return Promise.reject(next);
    if (typeof next === 'function') return Promise.resolve(next());
    return Promise.resolve(next);
  });

  const client = new IntegrationHttpClient({
    system: 'maximo',
    baseUrl: BASE_URL,
    timeoutMs: 1_000,
    maxRetries: 3,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 10_000,
    defaultHeaders: { MAXAUTH: FAKE_TOKEN, Accept: 'application/json' },
    fetchImpl: fetchMock,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    logger,
    ...overrides,
  });

  return { client, fetchMock, sleeps, lines };
}

const capture = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('IntegrationHttpClient', () => {
  describe('superficie pública (GET-only)', () => {
    it('el prototipo expone únicamente `get` (sin post/put/patch/delete)', () => {
      const names = Object.getOwnPropertyNames(IntegrationHttpClient.prototype);
      expect(names.sort()).toEqual(['constructor', 'get']);
      for (const forbidden of ['post', 'put', 'patch', 'delete', 'request']) {
        expect(forbidden in IntegrationHttpClient.prototype).toBe(false);
      }
    });

    it('siempre envía method GET y redirect manual a fetch', async () => {
      const { client, fetchMock } = makeClient([jsonResponse(200, {})]);
      await client.get('AB_COMPRAS');
      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('el estado es privado: JSON.stringify/inspect del cliente no exponen headers', () => {
      const { client } = makeClient([]);
      expect(Object.keys(client)).toEqual([]);
      expect(JSON.stringify(client)).not.toContain(FAKE_TOKEN);
      expect(inspect(client)).not.toContain(FAKE_TOKEN);
    });
  });

  describe('configuración', () => {
    it('exige system y baseUrl', () => {
      expect(
        () => new IntegrationHttpClient({ system: '', baseUrl: BASE_URL }),
      ).toThrow('`system` es obligatorio');
      expect(
        () => new IntegrationHttpClient({ system: 'sap', baseUrl: ' ' }),
      ).toThrow('`baseUrl` es obligatoria');
    });

    it.each(['/maxrest/rest/os', 'maximo.test/os', 'ftp://maximo.test/os'])(
      'rechaza baseUrl no absoluta http(s): %s (sin incluir la URL en el mensaje)',
      (baseUrl) => {
        let thrown: Error | undefined;
        try {
          new IntegrationHttpClient({
            system: 'maximo',
            baseUrl: `${baseUrl}?_lpwd=fake-pass`,
          });
        } catch (e: unknown) {
          thrown = e as Error;
        }
        expect(thrown).toBeDefined();
        expect(thrown!.message).toMatch(/`baseUrl` debe/);
        expect(thrown!.message).not.toContain('fake-pass');
      },
    );

    it('rechaza headers con CR/LF nombrando solo el header, nunca el valor', () => {
      expect(
        () =>
          new IntegrationHttpClient({
            system: 'maximo',
            baseUrl: BASE_URL,
            defaultHeaders: { MAXAUTH: 'part1\npart2-fake' },
          }),
      ).toThrow(/header "MAXAUTH" tiene un valor inválido/);
      expect(() => {
        new IntegrationHttpClient({
          system: 'maximo',
          baseUrl: BASE_URL,
          defaultHeaders: { MAXAUTH: 'part1\npart2-fake' },
        });
      }).not.toThrow(/part2-fake/);
    });

    it('rechaza headers por llamada con CR/LF antes de llamar a fetch', async () => {
      const { client, fetchMock } = makeClient([]);
      await expect(
        client.get('x', { headers: { Cookie: 'a=b\r\nInjected: 1' } }),
      ).rejects.toThrow(/header "Cookie" tiene un valor inválido/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rechaza números inválidos', () => {
      expect(
        () =>
          new IntegrationHttpClient({
            system: 'maximo',
            baseUrl: BASE_URL,
            timeoutMs: 0,
          }),
      ).toThrow('`timeoutMs` debe ser un número > 0');
      expect(
        () =>
          new IntegrationHttpClient({
            system: 'maximo',
            baseUrl: BASE_URL,
            maxRetries: Number.NaN,
          }),
      ).toThrow('`maxRetries` debe ser un número >= 0');
      expect(
        () =>
          new IntegrationHttpClient({
            system: 'maximo',
            baseUrl: BASE_URL,
            retryBaseDelayMs: -1,
          }),
      ).toThrow('`retryBaseDelayMs` debe ser un número >= 0');
    });

    it('la factory crea instancias independientes', () => {
      const factory = new IntegrationHttpClientFactory();
      const a = factory.create({ system: 'maximo', baseUrl: BASE_URL });
      const b = factory.create({ system: 'sap', baseUrl: 'https://sap.test' });
      expect(a).toBeInstanceOf(IntegrationHttpClient);
      expect(b).toBeInstanceOf(IntegrationHttpClient);
      expect(a).not.toBe(b);
    });

    it('aplica los defaults al comportamiento (4 intentos, backoff base 500ms)', async () => {
      const { client, fetchMock, sleeps } = makeClient(
        [
          textResponse(503, 'a'),
          textResponse(503, 'b'),
          textResponse(503, 'c'),
          textResponse(503, 'd'),
        ],
        {
          timeoutMs: undefined,
          maxRetries: undefined,
          retryBaseDelayMs: undefined,
          retryMaxDelayMs: undefined,
        },
      );
      const err = (await capture(client.get('x'))) as IntegrationServerError;
      expect(err).toBeInstanceOf(IntegrationServerError);
      expect(err.attempt).toBe(INTEGRATION_HTTP_DEFAULTS.maxRetries + 1);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      // random=0.5 → 0.75·500·2^(n-1)
      expect(sleeps).toEqual([375, 750, 1500]);
    });

    it('aplica el timeout default de 30s', async () => {
      jest.useFakeTimers();
      try {
        const { client } = makeClient(['hang'], {
          timeoutMs: undefined,
          maxRetries: 0,
        });
        const pending = capture(client.get('x'));
        await jest.advanceTimersByTimeAsync(
          INTEGRATION_HTTP_DEFAULTS.timeoutMs - 1,
        );
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        const err = (await pending) as IntegrationTimeoutError;
        expect(err).toBeInstanceOf(IntegrationTimeoutError);
        expect(err.timeoutMs).toBe(INTEGRATION_HTTP_DEFAULTS.timeoutMs);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('construcción de URL', () => {
    it('concatena baseUrl + path (normalizando barras) y omite query null/undefined', async () => {
      const { client, fetchMock } = makeClient([jsonResponse(200, {})], {
        baseUrl: `${BASE_URL}/`,
      });
      await client.get('/AB_COMPRAS', {
        query: {
          _format: 'json',
          _maxItems: 100,
          _rsStart: 0,
          skip: undefined,
          none: null,
          flag: false,
        },
      });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(
        `${BASE_URL}/AB_COMPRAS?_format=json&_maxItems=100&_rsStart=0&flag=false`,
      );
    });

    it('rechaza URLs absolutas como path', async () => {
      const { client, fetchMock } = makeClient([]);
      await expect(client.get('https://otro-host.test/x')).rejects.toThrow(
        'debe ser relativo a baseUrl',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('mezcla headers por llamada sobre defaultHeaders', async () => {
      const { client, fetchMock } = makeClient([jsonResponse(200, {})]);
      await client.get('x', {
        headers: { 'X-Trace': 'abc', Accept: 'text/xml' },
      });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers).toEqual({
        MAXAUTH: FAKE_TOKEN,
        Accept: 'text/xml',
        'X-Trace': 'abc',
      });
    });
  });

  describe('éxito', () => {
    it('éxito simple: devuelve body tipado + metadatos con attempts=1', async () => {
      const payload = { member: [{ PONUM: { content: 'PO-1' } }], rsCount: 1 };
      const { client, fetchMock, sleeps } = makeClient([
        jsonResponse(200, payload, { 'X-Total': '1' }),
      ]);

      const res = await client.get<typeof payload>('AB_COMPRAS');

      expect(res.data).toEqual(payload);
      expect(res.status).toBe(200);
      expect(res.attempts).toBe(1);
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
      expect(res.headers['x-total']).toBe('1');
      expect(res.url).toBe(`${BASE_URL}/AB_COMPRAS`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    });

    it('res.url viene saneada (sin valores de query sensibles)', async () => {
      const { client } = makeClient([jsonResponse(200, {})]);
      const res = await client.get('AB_COMPRAS', {
        query: { _lpwd: 'fake-query-pass', _format: 'json' },
      });
      expect(res.url).not.toContain('fake-query-pass');
      expect(res.url).toContain(`_lpwd=${REDACTED}`);
      expect(res.url).toContain('_format=json');
    });

    it('expone todos los Set-Cookie en setCookie', async () => {
      const headers = new Headers();
      headers.append('Set-Cookie', 'B1SESSION=fake-a; Path=/');
      headers.append('Set-Cookie', 'ROUTEID=.node1; Path=/');
      const { client } = makeClient([
        new Response('{}', { status: 200, headers }),
      ]);
      const res = await client.get('x');
      expect(res.setCookie).toEqual([
        'B1SESSION=fake-a; Path=/',
        'ROUTEID=.node1; Path=/',
      ]);
    });

    it('parseAs text devuelve el cuerpo crudo (p. ej. XML)', async () => {
      const xml = '<?xml version="1.0"?><root/>';
      const { client } = makeClient([textResponse(200, xml)]);
      const res = await client.get<string>('AB_COMPRAS', { parseAs: 'text' });
      expect(res.data).toBe(xml);
    });

    it.each([
      [204, null],
      [200, ''],
      [200, '   '],
    ])(
      'cuerpo vacío (%i) con parseAs json devuelve data undefined',
      async (status, body) => {
        const { client } = makeClient([new Response(body, { status })]);
        const res = await client.get('x');
        expect(res.status).toBe(status);
        expect(res.data).toBeUndefined();
      },
    );

    it('2xx con cuerpo no-JSON lanza IntegrationRequestError sin reintentos', async () => {
      const { client, fetchMock } = makeClient([
        textResponse(200, '<html>login page</html>'),
      ]);
      const err = (await capture(
        client.get('AB_COMPRAS'),
      )) as IntegrationRequestError;
      expect(err).toBeInstanceOf(IntegrationRequestError);
      expect(err.status).toBe(200);
      expect(err.body).toContain('<html>');
      expect(err.message).toContain('no es JSON válido');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('reintentos', () => {
    it('reintenta tras 5xx con backoff creciente y reporta attempts correctos', async () => {
      const { client, fetchMock, sleeps } = makeClient([
        textResponse(503, 'unavailable'),
        textResponse(502, 'bad gateway'),
        jsonResponse(200, { ok: true }),
      ]);

      const res = await client.get('AB_COMPRAS');

      expect(res.attempts).toBe(3);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // base 100ms, random=0.5 → equal jitter = 0.75·base·2^(n-1)
      expect(sleeps).toEqual([75, 150]);
      expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
    });

    it('reintenta tras error de red y termina con éxito', async () => {
      const { client, fetchMock, sleeps } = makeClient([
        networkError('ECONNRESET'),
        jsonResponse(200, { ok: true }),
      ]);
      const res = await client.get('AB_COMPRAS');
      expect(res.attempts).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleeps).toEqual([75]);
    });

    it('reintenta si el cuerpo se corta a mitad de lectura (error de red, no JSON inválido)', async () => {
      const socketErr = networkError('UND_ERR_SOCKET', 'terminated');
      const { client, fetchMock, sleeps } = makeClient([
        () => brokenBodyResponse(200, socketErr),
        jsonResponse(200, { ok: true }),
      ]);
      const res = await client.get<{ ok: boolean }>('AB_COMPRAS');
      expect(res.data).toEqual({ ok: true });
      expect(res.attempts).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleeps).toEqual([75]);
    });

    it('cuerpo cortado de forma persistente termina en IntegrationNetworkError', async () => {
      const socketErr = networkError('UND_ERR_SOCKET', 'terminated');
      const { client } = makeClient(
        [
          () => brokenBodyResponse(200, socketErr),
          () => brokenBodyResponse(503, socketErr),
        ],
        { maxRetries: 1 },
      );
      const err = (await capture(client.get('x'))) as IntegrationNetworkError;
      expect(err).toBeInstanceOf(IntegrationNetworkError);
      expect(err.code).toBe('UND_ERR_SOCKET');
      expect(err.attempt).toBe(2);
    });

    it('reintenta 429 y respeta Retry-After (acotado por retryMaxDelayMs)', async () => {
      const { client, sleeps } = makeClient([
        textResponse(429, 'slow down', { 'Retry-After': '2' }),
        jsonResponse(200, { ok: true }),
      ]);
      const res = await client.get('AB_COMPRAS');
      expect(res.attempts).toBe(2);
      expect(sleeps).toEqual([2_000]);
    });

    it('Retry-After nunca supera retryMaxDelayMs', async () => {
      const { client, sleeps } = makeClient(
        [
          textResponse(503, 'x', { 'Retry-After': '3600' }),
          jsonResponse(200, {}),
        ],
        { retryMaxDelayMs: 5_000 },
      );
      await client.get('x');
      expect(sleeps).toEqual([5_000]);
    });

    it('el backoff se acota por retryMaxDelayMs y conserva jitter en el tope', async () => {
      const script = () => [
        textResponse(500, 'a'),
        textResponse(500, 'b'),
        textResponse(500, 'c'),
        jsonResponse(200, {}),
      ];
      const half = makeClient(script(), {
        retryBaseDelayMs: 4_000,
        retryMaxDelayMs: 5_000,
      });
      await half.client.get('x');
      // exp acotado: [4000, 5000, 5000] → mitad fija + 0.5·mitad
      expect(half.sleeps).toEqual([3_000, 3_750, 3_750]);

      const low = makeClient(script(), {
        retryBaseDelayMs: 4_000,
        retryMaxDelayMs: 5_000,
        random: () => 0,
      });
      await low.client.get('x');
      expect(low.sleeps).toEqual([2_000, 2_500, 2_500]);
      expect(low.sleeps[2]).not.toBe(half.sleeps[2]);
      for (const ms of [...half.sleeps, ...low.sleeps]) {
        expect(ms).toBeLessThanOrEqual(5_000);
      }
    });

    it('maxRetries=0 no reintenta nunca', async () => {
      const { client, fetchMock, sleeps } = makeClient(
        [textResponse(503, 'x')],
        { maxRetries: 0 },
      );
      const err = (await capture(client.get('x'))) as IntegrationServerError;
      expect(err).toBeInstanceOf(IntegrationServerError);
      expect(err.attempt).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    });

    it('maxRetries fraccionario se redondea hacia abajo', async () => {
      const { client, fetchMock } = makeClient(
        [
          textResponse(503, 'a'),
          textResponse(503, 'b'),
          textResponse(503, 'c'),
        ],
        { maxRetries: 1.9 },
      );
      await capture(client.get('x'));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('errores sin reintento', () => {
    it.each([401, 403])(
      '%i lanza IntegrationAuthError SIN reintentos (con cuerpo truncado)',
      async (status) => {
        const { client, fetchMock, sleeps } = makeClient([
          textResponse(status, 'BMXAA7901E - denied'),
        ]);
        const err = (await capture(
          client.get('AB_COMPRAS'),
        )) as IntegrationAuthError;
        expect(err).toBeInstanceOf(IntegrationAuthError);
        expect(err).toBeInstanceOf(IntegrationError);
        expect(err.status).toBe(status);
        expect(err.attempt).toBe(1);
        expect(err.system).toBe('maximo');
        expect(err.body).toBe('BMXAA7901E - denied');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sleeps).toEqual([]);
      },
    );

    it('404 lanza IntegrationRequestError sin reintentos, con status y cuerpo truncado', async () => {
      const longBody = 'BMXAA8252E - Object structure not found. '.repeat(40);
      const { client, fetchMock, sleeps } = makeClient([
        textResponse(404, longBody),
      ]);
      const err = (await capture(
        client.get('AB_CONTRATOS'),
      )) as IntegrationRequestError;
      expect(err).toBeInstanceOf(IntegrationRequestError);
      expect(err.status).toBe(404);
      expect(err.body.length).toBeLessThanOrEqual(501);
      expect(err.body.endsWith('…')).toBe(true);
      expect(err.body.startsWith('BMXAA8252E')).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    });

    it('3xx (redirect manual) lanza IntegrationRequestError sin reintentos', async () => {
      const { client, fetchMock } = makeClient([
        textResponse(302, '', { Location: 'https://otro-host.test/login' }),
      ]);
      const err = (await capture(client.get('x'))) as IntegrationRequestError;
      expect(err).toBeInstanceOf(IntegrationRequestError);
      expect(err.status).toBe(302);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fallos deterministas de fetch (URL/header inválidos) no se reintentan', async () => {
      const invalidUrl = new TypeError('Failed to parse URL from x');
      (invalidUrl as Error & { cause: unknown }).cause = {
        code: 'ERR_INVALID_URL',
      };
      const { client, fetchMock, sleeps } = makeClient([invalidUrl]);
      const err = (await capture(client.get('x'))) as IntegrationNetworkError;
      expect(err).toBeInstanceOf(IntegrationNetworkError);
      expect(err.code).toBe('ERR_INVALID_URL');
      expect(err.attempt).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    });
  });

  describe('errores tras agotar reintentos', () => {
    it('5xx persistente lanza IntegrationServerError con attempt = maxRetries+1', async () => {
      const { client, fetchMock, sleeps } = makeClient([
        textResponse(500, 'e1'),
        textResponse(500, 'e2'),
        textResponse(500, 'e3'),
        textResponse(503, 'e4'),
      ]);
      const err = (await capture(client.get('x'))) as IntegrationServerError;
      expect(err).toBeInstanceOf(IntegrationServerError);
      expect(err.status).toBe(503);
      expect(err.body).toBe('e4');
      expect(err.attempt).toBe(4);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(sleeps).toHaveLength(3);
    });

    it('429 persistente lanza IntegrationRequestError (status 429) tras agotar intentos', async () => {
      const { client, fetchMock } = makeClient(
        [textResponse(429, 'a'), textResponse(429, 'b')],
        { maxRetries: 1 },
      );
      const err = (await capture(client.get('x'))) as IntegrationRequestError;
      expect(err).toBeInstanceOf(IntegrationRequestError);
      expect(err.status).toBe(429);
      expect(err.message).toContain('rate limit');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('error de red persistente lanza IntegrationNetworkError con code y cause depurado', async () => {
      const { client, fetchMock } = makeClient(
        [networkError('ECONNREFUSED'), networkError('ECONNREFUSED')],
        { maxRetries: 1 },
      );
      const err = (await capture(client.get('x'))) as IntegrationNetworkError;
      expect(err).toBeInstanceOf(IntegrationNetworkError);
      expect(err.code).toBe('ECONNREFUSED');
      expect(err.attempt).toBe(2);
      const cause = err.cause as Error & { code?: string };
      expect(cause).toBeInstanceOf(Error);
      expect(cause.name).toBe('TypeError');
      expect(cause.message).toBe('fetch failed');
      expect(cause.code).toBe('ECONNREFUSED');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('timeout lanza IntegrationTimeoutError tras agotar intentos (aborta la señal)', async () => {
      const { client, fetchMock, sleeps } = makeClient(
        ['hang', 'hang', 'hang'],
        { timeoutMs: 20, maxRetries: 2 },
      );
      const err = (await capture(client.get('x'))) as IntegrationTimeoutError;
      expect(err).toBeInstanceOf(IntegrationTimeoutError);
      expect(err.timeoutMs).toBe(20);
      expect(err.attempt).toBe(3);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleeps).toHaveLength(2);
      for (const [, init] of fetchMock.mock.calls) {
        expect(init.signal.aborted).toBe(true);
      }
    });

    it('el timeout también cubre la lectura del cuerpo (cuerpo colgado → timeout + reintento)', async () => {
      const { client, fetchMock, sleeps } = makeClient(
        [() => stalledBodyResponse(200), () => stalledBodyResponse(200)],
        { timeoutMs: 20, maxRetries: 1 },
      );
      const err = (await capture(client.get('x'))) as IntegrationTimeoutError;
      expect(err).toBeInstanceOf(IntegrationTimeoutError);
      expect(err.attempt).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleeps).toHaveLength(1);
      for (const [, init] of fetchMock.mock.calls) {
        expect(init.signal.aborted).toBe(true);
      }
    });

    it('cuerpo colgado tras cabeceras: se recupera si el reintento responde bien', async () => {
      const { client } = makeClient(
        [() => stalledBodyResponse(200), jsonResponse(200, { ok: true })],
        { timeoutMs: 20, maxRetries: 1 },
      );
      const res = await client.get<{ ok: boolean }>('x');
      expect(res.data).toEqual({ ok: true });
      expect(res.attempts).toBe(2);
    });

    it('timeoutMs por llamada sobreescribe el de la instancia', async () => {
      const { client, fetchMock } = makeClient(['hang'], {
        timeoutMs: 60_000,
        maxRetries: 0,
      });
      const err = (await capture(
        client.get('x', { timeoutMs: 15 }),
      )) as IntegrationTimeoutError;
      expect(err).toBeInstanceOf(IntegrationTimeoutError);
      expect(err.timeoutMs).toBe(15);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('el timeout se cumple aunque fetch ignore la señal de abort', async () => {
      const ignoringFetch: FetchLike = () =>
        new Promise<Response>(() => undefined);
      const { client } = makeClient([], {
        fetchImpl: ignoringFetch,
        timeoutMs: 15,
        maxRetries: 0,
      });
      const err = await capture(client.get('x'));
      expect(err).toBeInstanceOf(IntegrationTimeoutError);
    });
  });

  describe('onSuccessDetail (hook de log de éxito — Int-3 tarea B)', () => {
    it('sin hook, la línea de éxito no lleva detail (comportamiento previo intacto)', async () => {
      const { client, lines } = makeClient([jsonResponse(200, { ok: true })]);
      await client.get('x');
      const success = lines.find((l) => l.includes('status=200'));
      expect(success).toMatch(/status=200 \d+ms attempt=1\/4$/);
      expect(success).not.toContain('detail=');
    });

    it('con hook, el retorno se agrega como detail y recibe status/data/attempts', async () => {
      const { client, lines } = makeClient([
        jsonResponse(200, { rsTotal: 42 }),
      ]);
      const seen: unknown[] = [];
      await client.get('x', {
        onSuccessDetail: (info) => {
          seen.push(info);
          const data = info.data as { rsTotal: number };
          return `rsTotal=${data.rsTotal} attempts=${info.attempts}`;
        },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ status: 200, attempts: 1 });
      expect(lines.join('\n')).toContain('detail=rsTotal=42 attempts=1');
    });

    it('un hook que lanza se ignora: la petición y el log de éxito no cambian', async () => {
      const { client, lines } = makeClient([jsonResponse(200, { ok: true })]);
      const res = await client.get('x', {
        onSuccessDetail: () => {
          throw new Error('hook roto');
        },
      });
      expect(res.status).toBe(200);
      const success = lines.find((l) => l.includes('status=200'));
      expect(success).not.toContain('detail=');
      expect(lines.join('\n')).not.toContain('hook roto');
    });

    it('el detail devuelto se trunca a 200 caracteres', async () => {
      const { client, lines } = makeClient([jsonResponse(200, {})]);
      await client.get('x', { onSuccessDetail: () => 'x'.repeat(500) });
      const success = lines.find((l) => l.includes('status=200'))!;
      const detail = success.slice(success.indexOf('detail='));
      expect(detail.length).toBeLessThanOrEqual('detail='.length + 201);
      expect(detail.endsWith('…')).toBe(true);
    });
  });

  describe('redacción de secretos en logs y errores', () => {
    it('los logs de un request con MAXAUTH nunca contienen el token', async () => {
      const { client, lines } = makeClient([
        textResponse(503, 'x'),
        networkError('ECONNRESET'),
        textResponse(401, 'denied'),
      ]);
      await capture(
        client.get('AB_COMPRAS', {
          query: {
            _lid: 'svc-user',
            _lpwd: 'fake-query-pass',
            _format: 'json',
          },
          headers: { Cookie: 'B1SESSION=fake-cookie' },
        }),
      );

      expect(lines.length).toBeGreaterThanOrEqual(4); // headers(debug) + 3 intentos
      const joined = lines.join('\n');
      expect(joined).not.toContain(FAKE_TOKEN);
      expect(joined).not.toContain('fake-cookie');
      expect(joined).not.toContain('fake-query-pass');
      expect(joined).not.toContain('svc-user');
      expect(joined).toContain(REDACTED);
      expect(joined).toContain('_format=json');
      expect(joined).toContain('status=401');
      expect(joined).toContain('headers=[MAXAUTH, Accept, Cookie]');
    });

    it('los errores exponen la URL saneada y no transportan headers', async () => {
      const { client } = makeClient([textResponse(403, 'denied')]);
      const err = (await capture(
        client.get('AB_COMPRAS', { query: { _lpwd: 'fake-query-pass' } }),
      )) as IntegrationAuthError;

      expect(err.url).not.toContain('fake-query-pass');
      expect(err.url).toContain(`_lpwd=${REDACTED}`);
      expect(err.message).not.toContain(FAKE_TOKEN);
      expect(err.message).not.toContain('fake-query-pass');
      expect(JSON.stringify(err)).not.toContain(FAKE_TOKEN);
      expect(inspect(err)).not.toContain(FAKE_TOKEN);
      expect(inspect(err)).not.toContain('fake-query-pass');
    });

    it('el cause de los errores se depura: ni URL cruda ni valores de headers (incluso con util.inspect)', async () => {
      // Simula los TypeError de undici que incluyen la URL completa o el
      // valor del header en el mensaje / cause.input.
      const rawUrl = `${BASE_URL}/AB_COMPRAS?_lid=svc-user&_lpwd=fake-query-pass`;
      const urlErr = new TypeError(`Failed to parse URL from ${rawUrl}`);
      (urlErr as Error & { cause: unknown }).cause = Object.assign(
        new TypeError('Invalid URL'),
        { code: 'ERR_INVALID_URL', input: rawUrl },
      );
      const headerErr = new TypeError(
        `Headers.append: "${FAKE_TOKEN}" is an invalid header value.`,
      );

      for (const thrown of [urlErr, headerErr]) {
        const { client } = makeClient([thrown], { maxRetries: 0 });
        const err = (await capture(
          client.get('AB_COMPRAS', {
            query: { _lid: 'svc-user', _lpwd: 'fake-query-pass' },
          }),
        )) as IntegrationNetworkError;
        expect(err).toBeInstanceOf(IntegrationNetworkError);
        const dump = inspect(err, { depth: 10 });
        expect(dump).not.toContain('fake-query-pass');
        expect(dump).not.toContain('svc-user');
        expect(dump).not.toContain(FAKE_TOKEN);
        expect(dump).toContain(REDACTED);
        const cause = err.cause as Error & { cause?: { input?: unknown } };
        expect(cause).toBeInstanceOf(Error);
        expect(cause).not.toBe(thrown);
        expect(cause.cause?.input).toBeUndefined();
      }
    });
  });
});
