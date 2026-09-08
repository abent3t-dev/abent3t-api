import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FetchLike,
  IntegrationAuthError,
  IntegrationHttpClient,
  IntegrationHttpClientConfig,
  IntegrationHttpClientFactory,
  IntegrationRequestError,
  LoggerLike,
} from '../common';
import { MaximoClient } from './maximo.client';
import { MaximoConfig } from './maximo.config';
import {
  MaximoContractsDisabledError,
  MaximoFilterNotAppliedError,
  MaximoInvalidArgumentError,
  MaximoNotConfiguredError,
  MaximoResponseShapeError,
} from './maximo.errors';

/**
 * Fase INT-2. HTTP mockeado con fixtures reales sanitizados: NINGÚN test toca
 * la red. El token es una cadena ficticia.
 */
const FAKE_TOKEN = 'dG9rZW4tZGUtcHJ1ZWJh'; // ficticio
const LEGACY = 'http://maximo.test:9080/maxrest/rest/os';
const OSLC = 'http://maximo.test:9080/maximo/oslc/os';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'));

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type FetchCall = Parameters<FetchLike>;

interface Harness {
  client: MaximoClient;
  fetchMock: jest.Mock<Promise<Response>, FetchCall>;
  lines: string[];
  /** URL de la llamada n (decodificada) */
  url: (n?: number) => URL;
}

function makeClient(
  queue: Array<Response | Error>,
  configOverrides: Partial<MaximoConfig> = {},
): Harness {
  const lines: string[] = [];
  const logger: LoggerLike = {
    log: (m) => lines.push(`LOG ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m) => lines.push(`ERROR ${m}`),
    debug: (m) => lines.push(`DEBUG ${m}`),
  };
  const fetchMock = jest.fn<Promise<Response>, FetchCall>(() => {
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('fetchMock: cola vacía'));
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });

  // Factory real pero con fetch inyectado (sin red) y sin esperas.
  const factory = {
    create: (cfg: IntegrationHttpClientConfig) =>
      new IntegrationHttpClient({
        ...cfg,
        fetchImpl: fetchMock,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
        logger,
      }),
  } as unknown as IntegrationHttpClientFactory;

  const config: MaximoConfig = {
    baseUrl: LEGACY,
    oslcUrl: OSLC,
    authToken: FAKE_TOKEN,
    contractsEnabled: true,
    timeoutMs: 1_000,
    maxRetries: 0,
    ...configOverrides,
  };

  const client = new MaximoClient(factory, config, logger);
  return {
    client,
    fetchMock,
    lines,
    url: (n = 0) => new URL(fetchMock.mock.calls[n][0]),
  };
}

const capture = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('MaximoClient', () => {
  describe('AB_COMPRAS — listado legacy', () => {
    it('sin fechas usa REST legacy con _format=json, _maxItems y _rsStart', async () => {
      const { client, fetchMock, url, lines } = makeClient([
        jsonResponse(fixture('ab-compras.legacy-nested.page.json')),
      ]);
      const res = await client.fetchPurchaseOrders({ maxItems: 2, rsStart: 0 });

      const u = url();
      expect(u.origin + u.pathname).toBe(`${LEGACY}/AB_COMPRAS`);
      expect(u.searchParams.get('_format')).toBe('json');
      expect(u.searchParams.get('_maxItems')).toBe('2');
      expect(u.searchParams.get('_rsStart')).toBe('0');
      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('GET');
      expect(init.headers.MAXAUTH).toBe(FAKE_TOKEN);

      expect(res.api).toBe('legacy');
      expect(res.objectStructure).toBe('AB_COMPRAS');
      expect(res.records).toHaveLength(2);
      expect(res.records[0].ponum).toBe('PO100012');
      expect(res.raw).toHaveLength(2);
      expect(res.legacyPage).toEqual({ rsStart: 0, rsCount: 2, rsTotal: 4892 });
      expect(res.oslcPage).toBeNull();
      expect(res.filterCheck.kind).toBe('none');
      expect(res.http.status).toBe(200);
      expect(res.http.attempts).toBe(1);
      // H10: rsTotal/rsCount logueados por página
      expect(lines.join('\n')).toMatch(
        /AB_COMPRAS legacy rsStart=0 rsCount=2 rsTotal=4892 records=2/,
      );
      expect(lines.join('\n')).not.toContain(FAKE_TOKEN);
    });

    it('defaults: _maxItems=100 y _rsStart=0', async () => {
      const { client, url } = makeClient([
        jsonResponse(fixture('ab-compras.legacy.empty.json')),
      ]);
      const res = await client.fetchPurchaseOrders();
      expect(url().searchParams.get('_maxItems')).toBe('100');
      expect(url().searchParams.get('_rsStart')).toBe('0');
      expect(res.records).toEqual([]);
      expect(res.legacyPage?.rsCount).toBe(0);
    });
  });

  describe('AB_COMPRAS — rango por OSLC', () => {
    it('con from/to usa OSLC con lean=1, oslc.select=* y oslc.where de rango', async () => {
      const { client, url, lines } = makeClient([
        jsonResponse(fixture('ab-compras.oslc.range.json')),
      ]);
      const res = await client.fetchPurchaseOrders({
        from: '2026-01-01',
        to: '2026-05-01T00:00:00',
      });

      const u = url();
      expect(u.origin + u.pathname).toBe(`${OSLC}/AB_COMPRAS`);
      expect(u.searchParams.get('lean')).toBe('1');
      expect(u.searchParams.get('oslc.select')).toBe('*');
      expect(u.searchParams.get('oslc.where')).toBe(
        'orderdate>="2026-01-01T00:00:00" and orderdate<="2026-05-01T00:00:00"',
      );
      expect(u.searchParams.has('oslc.pageSize')).toBe(false);
      expect(u.searchParams.has('pageno')).toBe(false);

      expect(res.api).toBe('oslc');
      expect(res.records).toHaveLength(3);
      expect(res.legacyPage).toBeNull();
      expect(res.oslcPage).toEqual({
        totalCount: null,
        nextPageHref: null,
        pageNum: null,
      });
      expect(res.filterCheck).toMatchObject({
        kind: 'range',
        applied: true,
        violations: 0,
        unverifiable: 0,
      });
      expect(lines.join('\n')).toMatch(/AB_COMPRAS oslc records=3/);
      expect(lines.some((l) => l.startsWith('WARN'))).toBe(false);
    });

    it('solo from, con Date en UTC; pageSize/pageNo se envían solo si se indican', async () => {
      const { client, url } = makeClient([
        jsonResponse(fixture('ab-compras.oslc.page.SYNTHETIC.json')),
      ]);
      const res = await client.fetchPurchaseOrders({
        from: new Date(Date.UTC(2026, 0, 15, 8, 30, 0)),
        pageSize: 2,
        pageNo: 1,
      });
      const u = url();
      expect(u.searchParams.get('oslc.where')).toBe(
        'orderdate>="2026-01-15T08:30:00"',
      );
      expect(u.searchParams.get('oslc.pageSize')).toBe('2');
      expect(u.searchParams.get('pageno')).toBe('1');
      expect(res.oslcPage?.totalCount).toBe(8);
      expect(res.oslcPage?.nextPageHref).toContain('pageno=2');
    });

    it('to de solo fecha es inclusivo (fin de día) y los strings con zona se normalizan a UTC', async () => {
      const { client, url } = makeClient([
        jsonResponse(fixture('ab-compras.oslc.range.json')),
      ]);
      await client.fetchPurchaseOrders({
        from: '2026-01-15T02:30:00-06:00', // hora local con offset → UTC
        to: '2026-03-31', // solo fecha → fin de día inclusive
      });
      expect(url().searchParams.get('oslc.where')).toBe(
        'orderdate>="2026-01-15T08:30:00" and orderdate<="2026-03-31T23:59:59"',
      );
    });

    it('H5 rango: registros fuera de rango → warning + metadato, sin lanzar', async () => {
      const { client, lines } = makeClient([
        jsonResponse(fixture('ab-compras.oslc.range.json')),
      ]);
      // El fixture tiene orderdate de marzo/abril 2026; pedimos solo junio.
      const res = await client.fetchPurchaseOrders({
        from: '2026-06-01',
        to: '2026-06-30',
      });
      expect(res.records).toHaveLength(3);
      expect(res.filterCheck.applied).toBe(false);
      expect(res.filterCheck.violations).toBe(3);
      expect(res.filterCheck.unverifiable).toBe(0);
      expect(
        lines.some((l) => /^WARN .*filtro de rango no aplicado/.test(l)),
      ).toBe(true);
    });

    it('fechas inválidas lanzan MaximoInvalidArgumentError sin llamar a la red', async () => {
      const { client, fetchMock } = makeClient([]);
      await expect(
        client.fetchPurchaseOrders({ from: '01/06/2026' }),
      ).rejects.toBeInstanceOf(MaximoInvalidArgumentError);
      await expect(
        client.fetchPurchaseOrders({ to: new Date('nope') }),
      ).rejects.toBeInstanceOf(MaximoInvalidArgumentError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('AB_COMPRAS — por PONUM (igualdad legacy)', () => {
    it('envía PONUM=… y devuelve el registro cuando Maximo respeta el filtro', async () => {
      const { client, url } = makeClient([
        jsonResponse(fixture('ab-compras.legacy-compact.po102249.json')),
      ]);
      const res = await client.fetchPurchaseOrderByNumber('PO102249');
      expect(url().searchParams.get('PONUM')).toBe('PO102249');
      expect(url().searchParams.get('_format')).toBe('json');
      expect(res.records).toHaveLength(1);
      expect(res.records[0].abClasfPo).toBe('CAPEX');
      expect(res.filterCheck).toMatchObject({
        kind: 'equality',
        applied: true,
        violations: 0,
      });
      expect(res.raw[0]).toEqual(
        (
          fixture('ab-compras.legacy-compact.po102249.json') as {
            QueryAB_COMPRASResponse: { AB_COMPRASSet: { PO: unknown[] } };
          }
        ).QueryAB_COMPRASResponse.AB_COMPRASSet.PO[0],
      );
    });

    it('H5 igualdad: si Maximo ignora el filtro lanza MaximoFilterNotAppliedError', async () => {
      const { client } = makeClient([
        jsonResponse(fixture('ab-compras.legacy-nested.page.json')),
      ]);
      const err = (await capture(
        client.fetchPurchaseOrderByNumber('PO999999'),
      )) as MaximoFilterNotAppliedError;
      expect(err).toBeInstanceOf(MaximoFilterNotAppliedError);
      expect(err.objectStructure).toBe('AB_COMPRAS');
      expect(err.filter).toBe('PONUM');
      expect(err.expected).toBe('PO999999');
      expect(err.received).toContain('PO100012');
      expect(err.message).toContain('ignoró el filtro PONUM=PO999999');
    });

    it('PONUM inexistente: conjunto vacío sin error', async () => {
      const { client } = makeClient([
        jsonResponse(fixture('ab-compras.legacy.empty.json')),
      ]);
      const res = await client.fetchPurchaseOrderByNumber('PO999999');
      expect(res.records).toEqual([]);
      expect(res.filterCheck.applied).toBe(true);
    });

    it('identificador inválido lanza MaximoInvalidArgumentError sin red', async () => {
      const { client, fetchMock } = makeClient([]);
      await expect(
        client.fetchPurchaseOrderByNumber('PO 1" or 1=1'),
      ).rejects.toBeInstanceOf(MaximoInvalidArgumentError);
      await expect(
        client.fetchPurchaseOrderByNumber(''),
      ).rejects.toBeInstanceOf(MaximoInvalidArgumentError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('AB_CONTRATOS', () => {
    it('con MAXIMO_CONTRACTS_ENABLED=false los métodos fallan tipado SIN red', async () => {
      const { client, fetchMock } = makeClient([], { contractsEnabled: false });
      await expect(client.fetchContracts()).rejects.toBeInstanceOf(
        MaximoContractsDisabledError,
      );
      await expect(
        client.fetchContractByPrnum('PR102828'),
      ).rejects.toBeInstanceOf(MaximoContractsDisabledError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetchContracts: legacy paginado, PRs sin contrato mapeados con hasContract=false', async () => {
      const { client, url, lines } = makeClient([
        jsonResponse(fixture('ab-contratos.legacy-nested.no-contract.json')),
      ]);
      const res = await client.fetchContracts({ maxItems: 2 });
      const u = url();
      expect(u.origin + u.pathname).toBe(`${LEGACY}/AB_CONTRATOS`);
      expect(u.searchParams.get('_maxItems')).toBe('2');
      expect(res.records).toHaveLength(2);
      expect(res.records.every((c) => !c.hasContract)).toBe(true);
      expect(res.legacyPage?.rsTotal).toBe(5098);
      expect(lines.join('\n')).toMatch(/AB_CONTRATOS legacy .*rsTotal=5098/);
    });

    it('fetchContractByPrnum: OSLC con oslc.where=prnum="…" (único filtro validado)', async () => {
      const { client, url } = makeClient([
        jsonResponse(fixture('ab-contratos.oslc.pr102828.json')),
      ]);
      const res = await client.fetchContractByPrnum('PR102828');
      const u = url();
      expect(u.origin + u.pathname).toBe(`${OSLC}/AB_CONTRATOS`);
      expect(u.searchParams.get('oslc.where')).toBe('prnum="PR102828"');
      expect(u.searchParams.get('lean')).toBe('1');
      expect(res.api).toBe('oslc');
      expect(res.records).toHaveLength(1);
      expect(res.records[0].contractNum).toBe('1091');
      expect(res.records[0].contractRefNum).toBeNull();
      expect(res.filterCheck.kind).toBe('equality');
    });

    it('fetchContractByPrnum: registro de otro PR → MaximoFilterNotAppliedError', async () => {
      const { client } = makeClient([
        jsonResponse(fixture('ab-contratos.oslc.pr102828.json')),
      ]);
      await expect(
        client.fetchContractByPrnum('PR000001'),
      ).rejects.toBeInstanceOf(MaximoFilterNotAppliedError);
    });
  });

  describe('configuración', () => {
    it('sin MAXIMO_BASE_URL/MAXIMO_AUTH_TOKEN lanza MaximoNotConfiguredError sin red', async () => {
      const { client, fetchMock } = makeClient([], {
        baseUrl: null,
        authToken: null,
      });
      const err = (await capture(
        client.fetchPurchaseOrders(),
      )) as MaximoNotConfiguredError;
      expect(err).toBeInstanceOf(MaximoNotConfiguredError);
      expect(err.missing).toEqual(['MAXIMO_BASE_URL', 'MAXIMO_AUTH_TOKEN']);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rango sin MAXIMO_OSLC_URL lanza MaximoNotConfiguredError (legacy sí configurada)', async () => {
      const { client, fetchMock } = makeClient([], { oslcUrl: null });
      const err = (await capture(
        client.fetchPurchaseOrders({ from: '2026-01-01' }),
      )) as MaximoNotConfiguredError;
      expect(err).toBeInstanceOf(MaximoNotConfiguredError);
      expect(err.missing).toEqual(['MAXIMO_OSLC_URL']);
      expect(err.message).not.toContain(FAKE_TOKEN);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reutiliza la misma instancia HTTP por API entre llamadas', async () => {
      const { client, fetchMock } = makeClient([
        jsonResponse(fixture('ab-compras.legacy.empty.json')),
        jsonResponse(fixture('ab-compras.legacy.empty.json')),
      ]);
      await client.fetchPurchaseOrders();
      await client.fetchPurchaseOrders();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1].headers).toEqual(
        fetchMock.mock.calls[1][1].headers,
      );
    });
  });

  describe('errores de transporte y de forma', () => {
    it('401 se propaga como IntegrationAuthError (sin reintentos)', async () => {
      const { client, fetchMock } = makeClient([
        new Response(
          'BMXAA0021E - User name and password combination are not valid',
          {
            status: 401,
          },
        ),
      ]);
      await expect(client.fetchPurchaseOrders()).rejects.toBeInstanceOf(
        IntegrationAuthError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('OSLC 400 BMXAA8781E se propaga como IntegrationRequestError con el cuerpo', async () => {
      const { client } = makeClient([
        jsonResponse(fixture('oslc.error.bmxaa8781e.json'), 400),
      ]);
      const err = (await capture(
        client.fetchContractByPrnum('PR102828'),
      )) as IntegrationRequestError;
      expect(err).toBeInstanceOf(IntegrationRequestError);
      expect(err.status).toBe(400);
      expect(err.body).toContain('BMXAA8781E');
    });

    it('200 con {Error} OSLC o sobre legacy inesperado → MaximoResponseShapeError', async () => {
      const a = makeClient([
        jsonResponse(fixture('oslc.error.bmxaa8781e.json')),
      ]);
      const errA = (await capture(
        a.client.fetchContractByPrnum('PR102828'),
      )) as MaximoResponseShapeError;
      expect(errA).toBeInstanceOf(MaximoResponseShapeError);
      expect(errA.reasonCode).toBe('BMXAA8781E');

      const b = makeClient([jsonResponse({ unexpected: true })]);
      await expect(b.client.fetchPurchaseOrders()).rejects.toBeInstanceOf(
        MaximoResponseShapeError,
      );
    });

    it('XML (sin JSON) → IntegrationRequestError desde Int-1', async () => {
      const { client } = makeClient([
        new Response('<?xml version="1.0"?><QueryAB_COMPRASResponse/>', {
          status: 200,
        }),
      ]);
      await expect(client.fetchPurchaseOrders()).rejects.toBeInstanceOf(
        IntegrationRequestError,
      );
    });
  });
});
