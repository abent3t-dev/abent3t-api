import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { IntegrationHttpClientFactory } from '../common';
// `import type` obligatorio en tipos usados en la firma decorada (TS1272 con
// isolatedModules + emitDecoratorMetadata).
import type {
  IntegrationHttpClient,
  IntegrationHttpResponse,
  IntegrationQuery,
  LoggerLike,
} from '../common';
import { MaximoContractDto } from './dto/maximo-contract.dto';
import { MaximoPurchaseOrderDto } from './dto/maximo-po.dto';
import { MaximoApi, MaximoObjectStructure } from './dto/maximo-raw.types';
import { MAXIMO_CONFIG, MAXIMO_LOGGER } from './maximo.config';
import type { MaximoConfig } from './maximo.config';
import {
  MaximoContractsDisabledError,
  MaximoFilterNotAppliedError,
  MaximoInvalidArgumentError,
  MaximoNotConfiguredError,
} from './maximo.errors';
import {
  MaximoLegacyPageInfo,
  MaximoOslcPageInfo,
  parseLegacyEnvelope,
  parseOslcEnvelope,
  toContract,
  toPurchaseOrder,
} from './maximo.mapper';

/**
 * Cliente tipado de SOLO LECTURA para IBM Maximo (Fase INT-2).
 *
 * Construido SOBRE `IntegrationHttpClient` (GET-only estructural, Int-1): no
 * existe ningún camino alterno de HTTP. Dos instancias internas, una por API:
 *
 *  - REST legacy `/maxrest/rest/os/<OS>?_format=json` → igualdad (`PONUM=`) y
 *    paginación masiva (`_maxItems`/`_rsStart`, validada en prod 13 ago 2026).
 *    Acepta parámetros inválidos EN SILENCIO y falla con rangos de doble operador.
 *  - OSLC `/maximo/oslc/os/<OS>?lean=1&oslc.select=*&oslc.where=…` → rangos de
 *    fecha y filtro de AB_CONTRATOS por `prnum` (única propiedad raíz válida;
 *    `contractrefnum`/`contractnum` devuelven BMXAA8781E). OSLC solo está
 *    validado en el ambiente de pruebas maxapptest (2026-06-05); el smoke test
 *    contra producción queda pendiente para Int-3.
 *
 * H5: tras cada lectura con filtro se valida la respuesta. Igualdad incumplida
 * → `MaximoFilterNotAppliedError`; rango incumplido → warning + metadato.
 * H10: por página se loguean rsStart/rsCount/rsTotal (legacy) o
 * totalCount/nextPage (OSLC) vía el hook `onSuccessDetail` de Int-1 (tarea B
 * de Int-3): los contadores viajan en el `detail` de la propia línea de éxito
 * del log por intento, junto con la URL saneada.
 *
 * Sin persistencia, sin cron, sin lectura de la bandera de sincronización (MAXIMO_SYNC_*, Int-3).
 */

export interface MaximoFilterCheck {
  kind: 'none' | 'equality' | 'range';
  /** false cuando al menos un registro viola el filtro pedido. */
  applied: boolean;
  violations: number;
  /** Registros sin el campo necesario para verificar (p. ej. sin ORDERDATE). */
  unverifiable: number;
  description: string;
}

export interface MaximoFetchResult<T> {
  objectStructure: MaximoObjectStructure;
  api: MaximoApi;
  records: T[];
  /** Registros crudos tal como llegaron (para `raw` JSONB en Int-3). */
  raw: unknown[];
  legacyPage: MaximoLegacyPageInfo | null;
  oslcPage: MaximoOslcPageInfo | null;
  filterCheck: MaximoFilterCheck;
  http: { status: number; durationMs: number; attempts: number };
}

export interface FetchPurchaseOrdersParams {
  /** Límite inferior de ORDERDATE (inclusive). Activa la API OSLC. */
  from?: Date | string;
  /** Límite superior de ORDERDATE (inclusive). Activa la API OSLC. */
  to?: Date | string;
  /** Legacy: `_maxItems` (default 100). */
  maxItems?: number;
  /** Legacy: `_rsStart` (default 0). */
  rsStart?: number;
  /** OSLC: `oslc.pageSize`. Solo se envía si se indica (NO validado en prod). */
  pageSize?: number;
  /** OSLC: `pageno`. Solo se envía si se indica (NO validado en prod). */
  pageNo?: number;
}

export interface FetchContractsParams {
  maxItems?: number;
  rsStart?: number;
}

const DEFAULT_MAX_ITEMS = 100;
const IDENTIFIER_RE = /^[A-Za-z0-9._-]{1,50}$/;
const RECEIVED_SAMPLE = 5;

@Injectable()
export class MaximoClient {
  private readonly logger: LoggerLike;
  private legacy: IntegrationHttpClient | null = null;
  private oslc: IntegrationHttpClient | null = null;

  constructor(
    private readonly factory: IntegrationHttpClientFactory,
    @Inject(MAXIMO_CONFIG) private readonly config: MaximoConfig,
    // Solo para tests: en la app nadie provee MAXIMO_LOGGER → Logger de Nest.
    @Optional() @Inject(MAXIMO_LOGGER) logger?: LoggerLike,
  ) {
    this.logger = logger ?? new Logger('Integration:maximo');
  }

  // -------------------------------------------------------------------------
  // AB_COMPRAS
  // -------------------------------------------------------------------------

  /**
   * Lista POs. Sin fechas → REST legacy paginado (`_maxItems`/`_rsStart`,
   * validado en prod 13 ago 2026). Con `from`/`to` → OSLC con `oslc.where`
   * (rango validado solo en maxapptest; pendiente confirmarlo en prod).
   */
  async fetchPurchaseOrders(
    params: FetchPurchaseOrdersParams = {},
  ): Promise<MaximoFetchResult<MaximoPurchaseOrderDto>> {
    if (params.from === undefined && params.to === undefined) {
      const result = await this.getLegacy('AB_COMPRAS', {
        _maxItems: params.maxItems ?? DEFAULT_MAX_ITEMS,
        _rsStart: params.rsStart ?? 0,
      });
      return this.finish(result, toPurchaseOrder, noFilter());
    }

    const from =
      params.from === undefined ? null : toOslcDate(params.from, 'from');
    const to = params.to === undefined ? null : toOslcDate(params.to, 'to');
    const clauses: string[] = [];
    if (from) clauses.push(`orderdate>="${from}"`);
    if (to) clauses.push(`orderdate<="${to}"`);

    const result = await this.getOslc('AB_COMPRAS', {
      'oslc.where': clauses.join(' and '),
      'oslc.pageSize': params.pageSize,
      pageno: params.pageNo,
    });
    return this.finish(result, toPurchaseOrder, (records) =>
      checkDateRange(records, (po) => po.orderDate, from, to, 'orderdate'),
    );
  }

  /** Una PO por número. REST legacy `PONUM=` (igualdad validada en prod). */
  async fetchPurchaseOrderByNumber(
    ponum: string,
  ): Promise<MaximoFetchResult<MaximoPurchaseOrderDto>> {
    const expected = assertIdentifier(ponum, 'ponum');
    const result = await this.getLegacy('AB_COMPRAS', { PONUM: expected });
    return this.finish(result, toPurchaseOrder, (records) =>
      checkEquality(records, (po) => po.ponum, expected, 'AB_COMPRAS', 'PONUM'),
    );
  }

  // -------------------------------------------------------------------------
  // AB_CONTRATOS (deshabilitable vía MAXIMO_CONTRACTS_ENABLED, §20.2)
  // -------------------------------------------------------------------------

  /** Lista registros de AB_CONTRATOS (raíz PR). REST legacy paginado. */
  async fetchContracts(
    params: FetchContractsParams = {},
  ): Promise<MaximoFetchResult<MaximoContractDto>> {
    this.assertContractsEnabled();
    const result = await this.getLegacy('AB_CONTRATOS', {
      _maxItems: params.maxItems ?? DEFAULT_MAX_ITEMS,
      _rsStart: params.rsStart ?? 0,
    });
    return this.finish(result, toContract, noFilter());
  }

  /**
   * Registro de AB_CONTRATOS por PRNUM. Se usa OSLC (excepción a la regla
   * "igualdad → legacy") porque es el único filtro de AB_CONTRATOS que la
   * validación aceptó (`oslc.where=prnum="…"`, C5 en maxapptest); el filtro
   * legacy `PRNUM=` no fue probado y Maximo ignora filtros inválidos en
   * silencio, que es el riesgo H5 que se quiere evitar.
   */
  async fetchContractByPrnum(
    prnum: string,
  ): Promise<MaximoFetchResult<MaximoContractDto>> {
    this.assertContractsEnabled();
    const expected = assertIdentifier(prnum, 'prnum');
    const result = await this.getOslc('AB_CONTRATOS', {
      'oslc.where': `prnum="${expected}"`,
    });
    return this.finish(result, toContract, (records) =>
      checkEquality(records, (c) => c.prnum, expected, 'AB_CONTRATOS', 'PRNUM'),
    );
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private assertContractsEnabled(): void {
    if (!this.config.contractsEnabled) throw new MaximoContractsDisabledError();
  }

  private ensureClient(api: MaximoApi): IntegrationHttpClient {
    const existing = api === 'legacy' ? this.legacy : this.oslc;
    if (existing) return existing;

    const baseUrl =
      api === 'legacy' ? this.config.baseUrl : this.config.oslcUrl;
    const missing: string[] = [];
    if (!baseUrl)
      missing.push(api === 'legacy' ? 'MAXIMO_BASE_URL' : 'MAXIMO_OSLC_URL');
    if (!this.config.authToken) missing.push('MAXIMO_AUTH_TOKEN');
    if (missing.length || !baseUrl) throw new MaximoNotConfiguredError(missing);

    const client = this.factory.create({
      system: api === 'legacy' ? 'maximo' : 'maximo-oslc',
      baseUrl,
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      defaultHeaders: {
        MAXAUTH: this.config.authToken as string,
        Accept: 'application/json',
      },
    });
    if (api === 'legacy') this.legacy = client;
    else this.oslc = client;
    return client;
  }

  private async getLegacy(
    objectStructure: MaximoObjectStructure,
    query: IntegrationQuery,
  ): Promise<RawFetch> {
    const http = this.ensureClient('legacy');
    // `_format=json` SIEMPRE: sin él Maximo responde XML.
    const response = await http.get<unknown>(objectStructure, {
      query: { _format: 'json', ...query },
      // H10: contadores por página en el `detail` del log de éxito de Int-1
      // (hook de la tarea B de Int-3; si el sobre no parsea, Int-1 lo ignora
      // y el parse real de abajo lanza el error tipado).
      onSuccessDetail: ({ data }) => {
        const parsed = parseLegacyEnvelope(data, objectStructure);
        return `${objectStructure} legacy rsStart=${fmt(parsed.page.rsStart)} rsCount=${fmt(parsed.page.rsCount)} rsTotal=${fmt(parsed.page.rsTotal)} records=${parsed.records.length}`;
      },
    });
    const { records, page } = parseLegacyEnvelope(
      response.data,
      objectStructure,
    );
    return {
      objectStructure,
      api: 'legacy',
      records,
      legacyPage: page,
      oslcPage: null,
      response,
    };
  }

  private async getOslc(
    objectStructure: MaximoObjectStructure,
    query: IntegrationQuery,
  ): Promise<RawFetch> {
    const http = this.ensureClient('oslc');
    // `lean=1` + `oslc.select=*`: exactamente lo validado en el ambiente de
    // pruebas maxapptest (C1/C2/C5, 2026-06-05). OSLC NO se ha probado contra
    // el host productivo — smoke test pendiente para Int-3.
    const response = await http.get<unknown>(objectStructure, {
      query: { lean: 1, 'oslc.select': '*', ...query },
      // H10 vía hook de Int-1 (ver getLegacy).
      onSuccessDetail: ({ data }) => {
        const parsed = parseOslcEnvelope(data);
        return `${objectStructure} oslc records=${parsed.records.length} totalCount=${fmt(parsed.page.totalCount)} nextPage=${parsed.page.nextPageHref ? 'yes' : 'no'}`;
      },
    });
    const { records, page } = parseOslcEnvelope(response.data);
    return {
      objectStructure,
      api: 'oslc',
      records,
      legacyPage: null,
      oslcPage: page,
      response,
    };
  }

  private finish<T>(
    fetched: RawFetch,
    mapper: (raw: unknown) => T,
    check: (records: T[]) => MaximoFilterCheck,
  ): MaximoFetchResult<T> {
    const records = fetched.records.map(mapper);
    const filterCheck = check(records);
    if (!filterCheck.applied) {
      this.logger.warn(
        `${fetched.objectStructure} ${fetched.api}: filtro de rango no aplicado por Maximo — ${filterCheck.description}`,
      );
    }
    return {
      objectStructure: fetched.objectStructure,
      api: fetched.api,
      records,
      raw: fetched.records,
      legacyPage: fetched.legacyPage,
      oslcPage: fetched.oslcPage,
      filterCheck,
      http: {
        status: fetched.response.status,
        durationMs: fetched.response.durationMs,
        attempts: fetched.response.attempts,
      },
    };
  }
}

interface RawFetch {
  objectStructure: MaximoObjectStructure;
  api: MaximoApi;
  records: unknown[];
  legacyPage: MaximoLegacyPageInfo | null;
  oslcPage: MaximoOslcPageInfo | null;
  response: IntegrationHttpResponse<unknown>;
}

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

function fmt(value: number | null): string {
  return value === null ? '-' : String(value);
}

function noFilter(): () => MaximoFilterCheck {
  return () => ({
    kind: 'none',
    applied: true,
    violations: 0,
    unverifiable: 0,
    description: 'sin filtro',
  });
}

/** Identificadores (PONUM/PRNUM): solo alfanumérico, punto, guion y guion bajo. */
function assertIdentifier(value: string, name: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!IDENTIFIER_RE.test(trimmed)) {
    throw new MaximoInvalidArgumentError(
      `${name} inválido: se esperan 1-50 caracteres alfanuméricos (., -, _)`,
    );
  }
  return trimmed;
}

/**
 * Fechas para `oslc.where`: formato `YYYY-MM-DDTHH:mm:ss` (sin zona), el que
 * aceptó la validación C1 en maxapptest. Semántica:
 * - `Date` y strings CON zona (`Z` o `±hh:mm`) se convierten a UTC.
 * - Strings SIN zona se envían tal cual (los interpreta el servidor Maximo).
 * - `YYYY-MM-DD` en `from` → inicio de día; en `to` → fin de día (inclusive).
 */
function toOslcDate(value: Date | string, name: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new MaximoInvalidArgumentError(`${name}: fecha inválida`);
    }
    return value.toISOString().slice(0, 19);
  }
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return name === 'to' ? `${trimmed}T23:59:59` : `${trimmed}T00:00:00`;
  }
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      trimmed,
    );
  if (!match) {
    throw new MaximoInvalidArgumentError(
      `${name}: se esperaba YYYY-MM-DD o YYYY-MM-DDTHH:mm:ss[±zona]`,
    );
  }
  if (match[2]) {
    // Con zona explícita no se recorta en silencio: se normaliza a UTC.
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      throw new MaximoInvalidArgumentError(`${name}: fecha inválida`);
    }
    return new Date(parsed).toISOString().slice(0, 19);
  }
  return match[1];
}

/** Igualdad (H5): todos los registros deben tener la clave pedida; si no, error. */
function checkEquality<T>(
  records: T[],
  key: (record: T) => string | null,
  expected: string,
  objectStructure: MaximoObjectStructure,
  filter: string,
): MaximoFilterCheck {
  const received = records.map((r) => key(r) ?? '(sin clave)');
  const violations = received.filter(
    (v) => v.toUpperCase() !== expected.toUpperCase(),
  );
  if (violations.length > 0) {
    throw new MaximoFilterNotAppliedError({
      objectStructure,
      filter,
      expected,
      received: received.slice(0, RECEIVED_SAMPLE),
    });
  }
  return {
    kind: 'equality',
    applied: true,
    violations: 0,
    unverifiable: 0,
    description: `${filter}=${expected}`,
  };
}

/** Rango (H5): registros fuera del rango → warning + metadato, no error. */
function checkDateRange<T>(
  records: T[],
  date: (record: T) => string | null,
  from: string | null,
  to: string | null,
  field: string,
): MaximoFilterCheck {
  let violations = 0;
  let unverifiable = 0;
  for (const record of records) {
    const raw = date(record);
    const parsed = raw === null ? Number.NaN : Date.parse(raw);
    if (Number.isNaN(parsed)) {
      unverifiable += 1;
      continue;
    }
    const iso = new Date(parsed).toISOString().slice(0, 19);
    if ((from !== null && iso < from) || (to !== null && iso > to)) {
      violations += 1;
    }
  }
  const description = `${field} en [${from ?? '-∞'}, ${to ?? '+∞'}]: ${violations} fuera de rango, ${unverifiable} sin fecha, ${records.length} total`;
  return {
    kind: 'range',
    applied: violations === 0,
    violations,
    unverifiable,
    description,
  };
}
