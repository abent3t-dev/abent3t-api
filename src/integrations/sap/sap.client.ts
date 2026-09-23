import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  IntegrationAuthError,
  IntegrationHttpClient,
  IntegrationHttpClientFactory,
} from '../common';
import type { IntegrationGetOptions, LoggerLike } from '../common';
import { SAP_CONFIG, SAP_LOGGER } from './sap.config';
import type { SapConfig } from './sap.config';
import { SapNotConfiguredError, SapResponseShapeError } from './sap.errors';
import { SapSessionManager } from './sap-session.manager';
import { createSapFetch } from './sap-transport';
import {
  toSapBusinessPartner,
  toSapPurchaseOrder,
  toSapPurchaseRequest,
} from './sap.mapper';
import {
  SapBusinessPartnerDto,
  SapPurchaseOrderDto,
  SapPurchaseRequestDto,
} from './dto/sap-document.dto';
import { SapRawCollection } from './dto/sap-raw.types';

/**
 * Cliente SAP B1 Service Layer (Fase INT-4). SOLO LECTURA: todos los métodos
 * son GET vía `IntegrationHttpClient` (Int-1, GET-only estructural); el único
 * POST del flujo (el login) vive aislado en `SapSessionManager` (T2).
 *
 * Reglas OData validadas en vivo contra PRD_ABENT (2026-09-17):
 * - `$expand=DocumentLines` → HTTP 400: las líneas se piden con
 *   `$select=...,DocumentLines` (llegan completas, ~32 KB/doc).
 * - Paginación estable con `$orderby=DocEntry` + `$top`/`$skip`.
 * - Incremental con `$filter=UpdateDate ge YYYY-MM-DD` (granularidad día).
 * - `PurchaseRequests` rechaza `$select` de CardCode/CardName/DocTotal.
 * - `DocTotal` viene SIEMPRE en moneda local (MXN); el importe en la moneda
 *   del documento es `DocTotalFc` (validado 2026-09-23 con la OC 5128:
 *   DocTotal 421,530.49 MXN = DocTotalFc 22,620 USD).
 * - `PurchaseOrders` no tiene Requester/RequesterName (HTTP 400): el
 *   solicitante sale de la solicitud base; `UserSign` = quién la capturó.
 * - Las OC que crea la integración Maximo → SAP traen `U_POID` (POID de
 *   Maximo) y `NumAtCard` = PONUM de Maximo (validado con la OC 6364:
 *   NumAtCard PO104910).
 *
 * Ante un 401 en un GET (sesión expirada en el server) se invalida la sesión
 * cacheada, se re-loguea y se reintenta UNA vez.
 */

const PO_SELECT = [
  'DocEntry',
  'DocNum',
  'DocDate',
  'DocDueDate',
  'UpdateDate',
  'CardCode',
  'CardName',
  'DocTotal',
  'DocTotalFc',
  'DocCurrency',
  'UserSign',
  'NumAtCard',
  'U_POID',
  'DocumentStatus',
  'Cancelled',
  'CancelStatus',
  'AuthorizationStatus',
  'Confirmed',
  'ClosingDate',
  'Comments',
  'DocumentLines',
].join(',');

const PR_SELECT = [
  'DocEntry',
  'DocNum',
  'DocDate',
  'DocDueDate',
  'RequriedDate', // sic: así se llama el campo en SAP
  'UpdateDate',
  'DocCurrency',
  'DocumentStatus',
  'Cancelled',
  'CancelStatus',
  'AuthorizationStatus',
  'Confirmed',
  'ClosingDate',
  'Comments',
  'Requester',
  'RequesterName',
  'DocumentLines',
].join(',');

/** Drafts sin DocumentLines (validado 2026-09-22: el $select reducido funciona). */
const DRAFT_SELECT = [
  'DocEntry',
  'DocNum',
  'DocDate',
  'DocObjectCode',
  'DocumentStatus',
  'AuthorizationStatus',
  'Requester',
  'RequesterName',
  'CardName',
  'DocTotal',
  'DocTotalFc',
  'DocCurrency',
  'Comments',
].join(',');

/** Tope de páginas al leer catálogos completos (Users/Stages/Templates/Drafts). */
const CATALOG_MAX_PAGES = 200;

const BP_SELECT = [
  'CardCode',
  'CardName',
  'CardType',
  'FederalTaxID',
  'EmailAddress',
  'Phone1',
  'Phone2',
  'ContactPerson',
  'Website',
  'Currency',
  'Valid',
  'Frozen',
  'UpdateDate',
].join(',');

/** Solo proveedores; los clientes (cCustomer) no son de Compras. */
const BP_TYPE_FILTER = "CardType%20eq%20'cSupplier'";

export interface SapFetchParams {
  top: number;
  skip: number;
  /** Corte incremental: solo documentos con UpdateDate >= esta fecha. */
  updatedSince?: Date;
}

export interface SapFetchResult<T> {
  records: T[];
  /** Documentos crudos tal como llegaron (para `raw` JSONB del staging). */
  raw: unknown[];
  http: { status: number; durationMs: number; attempts: number };
}

@Injectable()
export class SapClient {
  #http: IntegrationHttpClient | null = null;

  constructor(
    private readonly factory: IntegrationHttpClientFactory,
    @Inject(SAP_CONFIG) private readonly config: SapConfig,
    private readonly session: SapSessionManager,
    @Optional() @Inject(SAP_LOGGER) private readonly logger?: LoggerLike,
  ) {}

  async fetchPurchaseOrders(
    params: SapFetchParams,
  ): Promise<SapFetchResult<SapPurchaseOrderDto>> {
    const path = collectionPath('PurchaseOrders', PO_SELECT, params);
    const { raw, http } = await this.getCollection(path);
    return { records: raw.map(toSapPurchaseOrder), raw, http };
  }

  async fetchPurchaseRequests(
    params: SapFetchParams,
  ): Promise<SapFetchResult<SapPurchaseRequestDto>> {
    const path = collectionPath('PurchaseRequests', PR_SELECT, params);
    const { raw, http } = await this.getCollection(path);
    return { records: raw.map(toSapPurchaseRequest), raw, http };
  }

  /**
   * Proveedores (BusinessPartners cSupplier). Sin `$orderby=DocEntry`: la
   * clave/orden estable aquí es CardCode.
   */
  async fetchBusinessPartners(
    params: SapFetchParams,
  ): Promise<SapFetchResult<SapBusinessPartnerDto>> {
    let path =
      `BusinessPartners?$select=${BP_SELECT}` +
      `&$orderby=CardCode&$top=${params.top}&$skip=${params.skip}` +
      `&$filter=${BP_TYPE_FILTER}`;
    if (params.updatedSince) {
      path += `%20and%20${updateDateFilter(params.updatedSince)}`;
    }
    const { raw, http } = await this.getCollection(path);
    return { records: raw.map(toSapBusinessPartner), raw, http };
  }

  // ── Cola de autorización (B5) ──────────────────────────────────────────

  /** Solicitudes de autorización paginadas por Code (no tienen UpdateDate). */
  async fetchApprovalRequests(params: {
    top: number;
    skip: number;
  }): Promise<{ raw: unknown[]; http: SapFetchResult<never>['http'] }> {
    const path = `ApprovalRequests?$orderby=Code&$top=${params.top}&$skip=${params.skip}`;
    return this.getCollection(path);
  }

  async countApprovalRequests(): Promise<number> {
    const response = await this.getWithSession<string>(
      'ApprovalRequests/$count',
      { parseAs: 'text' },
    );
    const parsed = Number(String(response.data).trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new SapResponseShapeError(
        '$count de ApprovalRequests no devolvió un entero',
      );
    }
    return parsed;
  }

  /** Borradores (slim) completos, para enlazar DraftEntry → datos. */
  fetchAllDraftsSlim(pageSize: number): Promise<unknown[]> {
    return this.fetchAll(
      `Drafts?$select=${DRAFT_SELECT}&$orderby=DocEntry`,
      pageSize,
    );
  }

  fetchAllUsers(pageSize: number): Promise<unknown[]> {
    return this.fetchAll(
      'Users?$select=InternalKey,UserCode,UserName&$orderby=InternalKey',
      pageSize,
    );
  }

  fetchAllApprovalStages(pageSize: number): Promise<unknown[]> {
    return this.fetchAll(
      'ApprovalStages?$select=Code,Name&$orderby=Code',
      pageSize,
    );
  }

  fetchAllApprovalTemplates(pageSize: number): Promise<unknown[]> {
    return this.fetchAll(
      'ApprovalTemplates?$select=Code,Name&$orderby=Code',
      pageSize,
    );
  }

  /**
   * Lee una colección completa tolerando el server-cap del Service Layer
   * ($top acotado a PageSize): avanza lo recibido y termina solo en página
   * vacía. Solo para catálogos chicos (cientos de filas).
   */
  private async fetchAll(
    basePath: string,
    pageSize: number,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let skip = 0;
    for (let guard = 0; guard < CATALOG_MAX_PAGES; guard++) {
      const { raw } = await this.getCollection(
        `${basePath}&$top=${pageSize}&$skip=${skip}`,
      );
      if (raw.length === 0) break;
      out.push(...raw);
      skip += raw.length;
    }
    return out;
  }

  async countPurchaseOrders(updatedSince?: Date): Promise<number> {
    return this.getCount('PurchaseOrders', updatedSince);
  }

  async countPurchaseRequests(updatedSince?: Date): Promise<number> {
    return this.getCount('PurchaseRequests', updatedSince);
  }

  async countBusinessPartners(updatedSince?: Date): Promise<number> {
    let path = `BusinessPartners/$count?$filter=${BP_TYPE_FILTER}`;
    if (updatedSince) path += `%20and%20${updateDateFilter(updatedSince)}`;
    const response = await this.getWithSession<string>(path, {
      parseAs: 'text',
    });
    const parsed = Number(String(response.data).trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new SapResponseShapeError(
        '$count de BusinessPartners no devolvió un entero',
      );
    }
    return parsed;
  }

  // -------------------------------------------------------------------------

  private async getCollection(
    path: string,
  ): Promise<{ raw: unknown[]; http: SapFetchResult<never>['http'] }> {
    const response = await this.getWithSession<SapRawCollection>(path, {
      onSuccessDetail: ({ data }) => {
        const value = (data as SapRawCollection | undefined)?.value;
        return Array.isArray(value) ? `value=${value.length}` : undefined;
      },
    });
    const value = response.data?.value;
    if (!Array.isArray(value)) {
      throw new SapResponseShapeError(
        'la colección no trae el arreglo `value`',
      );
    }
    return {
      raw: value,
      http: {
        status: response.status,
        durationMs: response.durationMs,
        attempts: response.attempts,
      },
    };
  }

  private async getCount(
    entity: 'PurchaseOrders' | 'PurchaseRequests',
    updatedSince?: Date,
  ): Promise<number> {
    let path = `${entity}/$count`;
    if (updatedSince) path += `?$filter=${updateDateFilter(updatedSince)}`;
    const response = await this.getWithSession<string>(path, {
      parseAs: 'text',
    });
    const parsed = Number(String(response.data).trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new SapResponseShapeError(
        `$count de ${entity} no devolvió un entero`,
      );
    }
    return parsed;
  }

  /** GET con cookie de sesión; ante 401 re-loguea y reintenta UNA vez. */
  private async getWithSession<T>(
    path: string,
    options: Omit<IntegrationGetOptions, 'headers'>,
  ) {
    const http = this.httpClient();
    const cookie = await this.session.getCookieHeader();
    try {
      return await http.get<T>(path, {
        ...options,
        headers: { Cookie: cookie },
      });
    } catch (err: unknown) {
      // Solo 401 = sesión expirada; un 403 es de permisos y re-loguear no
      // ayuda (IntegrationAuthError cubre ambos, se discrimina por status).
      if (!(err instanceof IntegrationAuthError) || err.status !== 401) {
        throw err;
      }
      this.logger?.warn?.(
        'GET a SAP devolvió 401: sesión expirada en el server — re-login y reintento único',
      );
      this.session.invalidate(cookie);
      const freshCookie = await this.session.getCookieHeader();
      return http.get<T>(path, {
        ...options,
        headers: { Cookie: freshCookie },
      });
    }
  }

  private httpClient(): IntegrationHttpClient {
    if (this.#http) return this.#http;
    const missing = this.session.missingConfig();
    if (missing.length > 0) throw new SapNotConfiguredError(missing);
    this.#http = this.factory.create({
      system: 'sap',
      baseUrl: this.config.baseUrl as string,
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      defaultHeaders: { Accept: 'application/json' },
      fetchImpl: createSapFetch({
        rejectUnauthorized: this.config.rejectUnauthorized,
      }),
      logger: this.logger,
    });
    return this.#http;
  }
}

// ---------------------------------------------------------------------------
// Helpers de módulo
// ---------------------------------------------------------------------------

/**
 * Path OData con query construida a mano: los valores son internos (nunca
 * entrada de usuario — el dominio solo lee staging) y los espacios del
 * `$filter` van como %20 (URLSearchParams los emitiría como `+`, que algunos
 * servidores OData interpretan literal).
 */
function collectionPath(
  entity: string,
  select: string,
  params: SapFetchParams,
): string {
  let path =
    `${entity}?$select=${select}` +
    `&$orderby=DocEntry&$top=${params.top}&$skip=${params.skip}`;
  if (params.updatedSince) {
    path += `&$filter=${updateDateFilter(params.updatedSince)}`;
  }
  return path;
}

/** `UpdateDate ge YYYY-MM-DD` con espacios %20 (validado sin comillas). */
function updateDateFilter(since: Date): string {
  const day = since.toISOString().slice(0, 10);
  return `UpdateDate%20ge%20${day}`;
}
