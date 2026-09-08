import {
  IntegrationLogger,
  isSensitiveHeaderName,
  isSensitiveQueryParam,
  LoggerLike,
  REDACTED,
  redactHeaders,
  sanitizeUrl,
} from './integration-logger';

/**
 * Fase INT-1. Los "tokens" de este archivo son cadenas ficticias de test;
 * no corresponden a ninguna credencial real.
 */
describe('redactHeaders', () => {
  it('redacta headers de autenticación sin importar mayúsculas/minúsculas', () => {
    const out = redactHeaders({
      MAXAUTH: 'bWF4YWRtaW46ZmFrZQ==',
      Authorization: 'Bearer fake-token',
      cookie: 'B1SESSION=fake-session',
      'Set-Cookie': 'B1SESSION=fake-session; Path=/',
      'api-key': 'fake-api-key',
      apikey: 'fake-apikey',
      Accept: 'application/json',
    });
    expect(out).toEqual({
      MAXAUTH: REDACTED,
      Authorization: REDACTED,
      cookie: REDACTED,
      'Set-Cookie': REDACTED,
      'api-key': REDACTED,
      apikey: REDACTED,
      Accept: 'application/json',
    });
  });

  it('redacta por heurística nombres no listados que contienen auth/token/secret/session', () => {
    const out = redactHeaders({
      'X-Maximo-Token': 'fake-1',
      'X-Secret-Access': 'fake-2',
      'X-Session-Id': 'fake-3',
      'X-Auth': 'fake-4',
      'Content-Type': 'application/json',
      'Keep-Alive': 'timeout=5',
    });
    expect(out['X-Maximo-Token']).toBe(REDACTED);
    expect(out['X-Secret-Access']).toBe(REDACTED);
    expect(out['X-Session-Id']).toBe(REDACTED);
    expect(out['X-Auth']).toBe(REDACTED);
    expect(out['Content-Type']).toBe('application/json');
    expect(out['Keep-Alive']).toBe('timeout=5');
  });

  it('no muta el objeto original y tolera undefined', () => {
    const input = { MAXAUTH: 'fake' };
    const out = redactHeaders(input);
    expect(input.MAXAUTH).toBe('fake');
    expect(out).not.toBe(input);
    expect(redactHeaders(undefined)).toEqual({});
  });
});

describe('isSensitiveHeaderName / isSensitiveQueryParam', () => {
  it.each(['MAXAUTH', 'apikey', 'X-CSRF-Token', 'Proxy-Authorization'])(
    'header %s es sensible',
    (name) => expect(isSensitiveHeaderName(name)).toBe(true),
  );
  it.each(['Accept', 'Content-Type', 'Keep-Alive', 'X-Trace'])(
    'header %s no es sensible',
    (name) => expect(isSensitiveHeaderName(name)).toBe(false),
  );
  it.each(['_lid', '_lpwd', 'sig', 'client_secret', 'SessionId'])(
    'query %s es sensible',
    (name) => expect(isSensitiveQueryParam(name)).toBe(true),
  );
  it.each(['_format', '_maxItems', '_rsStart', 'oslc.where', '$top'])(
    'query %s no es sensible',
    (name) => expect(isSensitiveQueryParam(name)).toBe(false),
  );
});

describe('sanitizeUrl', () => {
  it('redacta _lid/_lpwd (API legacy de Maximo) y conserva el resto de la query', () => {
    const url =
      'http://maximo.example/maxrest/rest/os/AB_COMPRAS?_lid=svc&_lpwd=fake-pass&_format=json&_maxItems=100';
    const out = sanitizeUrl(url);
    expect(out).not.toContain('fake-pass');
    expect(out).not.toContain('_lid=svc');
    expect(out).toContain('_format=json');
    expect(out).toContain('_maxItems=100');
    expect(out).toContain(`_lpwd=${REDACTED}`);
    expect(out).not.toContain('%5B');
  });

  it('redacta token/password/api_key con cualquier capitalización', () => {
    const out = sanitizeUrl(
      'https://sap.example/b1s/v2/Items?Token=abc&PASSWORD=def&api_key=ghi&$top=5',
    );
    expect(out).not.toMatch(/abc|def|ghi/);
    expect(out).toContain('%24top=5');
  });

  it('redacta userinfo en la URL', () => {
    const out = sanitizeUrl('http://user:fake-pass@host.example/path');
    expect(out).not.toContain('fake-pass');
    expect(out).not.toContain('user:');
    expect(out).toContain('host.example/path');
  });

  it('si la URL no se puede parsear descarta la query completa', () => {
    expect(sanitizeUrl('not a url?token=fake')).toBe(`not a url?${REDACTED}`);
    expect(sanitizeUrl('not a url')).toBe('not a url');
  });
});

describe('IntegrationLogger', () => {
  const makeLogger = () => {
    const lines: string[] = [];
    const sink: LoggerLike = {
      log: (m) => lines.push(`LOG ${m}`),
      warn: (m) => lines.push(`WARN ${m}`),
      error: (m) => lines.push(`ERROR ${m}`),
      debug: (m) => lines.push(`DEBUG ${m}`),
    };
    return { logger: new IntegrationLogger('maximo', sink), lines };
  };

  it('enruta success→log, retry→warn, failure→error con URL saneada', () => {
    const { logger, lines } = makeLogger();
    const url =
      'http://maximo.example/os/AB_COMPRAS?_lpwd=fake-pass&_format=json';
    logger.request({
      method: 'GET',
      url,
      status: 200,
      durationMs: 12,
      attempt: 1,
      maxAttempts: 4,
      outcome: 'success',
    });
    logger.request({
      method: 'GET',
      url,
      status: 503,
      durationMs: 8,
      attempt: 1,
      maxAttempts: 4,
      outcome: 'retry',
      nextDelayMs: 250,
    });
    logger.request({
      method: 'GET',
      url,
      durationMs: 30_000,
      attempt: 4,
      maxAttempts: 4,
      outcome: 'failure',
      detail: 'timeout',
    });

    expect(lines[0]).toMatch(/^LOG GET .* status=200 12ms attempt=1\/4$/);
    expect(lines[1]).toMatch(
      /^WARN GET .* status=503 8ms attempt=1\/4 retry_in=250ms$/,
    );
    expect(lines[2]).toMatch(
      /^ERROR GET .* status=- 30000ms attempt=4\/4 detail=timeout$/,
    );
    for (const line of lines) {
      expect(line).not.toContain('fake-pass');
      expect(line).toContain('_format=json');
    }
  });

  it('headers() solo emite en debug y únicamente los nombres', () => {
    const { logger, lines } = makeLogger();
    logger.headers({ MAXAUTH: 'fake-token-value', Accept: 'application/json' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('DEBUG headers=[MAXAUTH, Accept]');
    expect(lines[0]).not.toContain('fake-token-value');
    expect(lines[0]).not.toContain('application/json');
  });

  it('headers() no hace nada si el logger no tiene debug', () => {
    const lines: string[] = [];
    const sink: LoggerLike = {
      log: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    };
    new IntegrationLogger('sap', sink).headers({ Authorization: 'x' });
    expect(lines).toHaveLength(0);
  });
});
