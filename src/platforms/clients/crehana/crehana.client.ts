import { Injectable, Logger } from '@nestjs/common';
import {
  CrehanaConfig,
  CrehanaCursorPaginated,
  CrehanaOffsetPaginated,
  CrehanaUserOrganization,
  CrehanaCatalogContent,
  CrehanaGeneralReportRow,
  CrehanaPerformanceReportRow,
} from './crehana.types';

/**
 * Cliente HTTP para la Crehana Centralized Public API v5.
 *
 * Documentación: https://www.crehana.com/api/v5/rest/redocs
 *
 * Alcance: SOLO LECTURA. ABENT consume datos de Crehana para mostrarlos.
 * No registra usuarios, no asigna cursos, no escribe nada.
 *
 * Auth: headers `api-key` y `secret-access` (atención: NO `secret-key`).
 */
/**
 * Timeout total por request (incluye DNS + TCP + TLS + body).
 * Subido a 60s para tolerar redes lentas o saturadas, donde solo la
 * resolución DNS puede llevarse 10+ segundos.
 *
 * Nota: el default INTERNO de undici para `connect.timeout` es 10s y NO se
 * puede modificar sin importar la lib `undici` directamente. Si en redes
 * muy saturadas seguimos viendo `UND_ERR_CONNECT_TIMEOUT` antes de los 60s,
 * habrá que instalar `undici` como dep y configurar un Agent con timeout largo.
 */
const REQUEST_TIMEOUT_MS = 60_000;

@Injectable()
export class CrehanaClient {
  private readonly logger = new Logger(CrehanaClient.name);

  private config: CrehanaConfig | null = null;

  configure(config: CrehanaConfig): void {
    this.config = config;
    this.logger.log(`Crehana client configured for org: ${config.organization_slug}`);
  }

  private ensureConfigured(): void {
    if (!this.config) {
      throw new Error('Crehana client not configured. Call configure() first.');
    }
  }

  private getHeaders(): Record<string, string> {
    this.ensureConfigured();
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'api-key': this.config!.api_key,
      'secret-access': this.config!.secret_access,
    };
  }

  /** Construye la URL completa: {api_url}/org/{slug}{path} */
  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    this.ensureConfigured();
    const base = this.config!.api_url.replace(/\/$/, '');
    const slug = this.config!.organization_slug;
    let url = `${base}/org/${slug}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') {
          params.append(k, String(v));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  private async request<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = this.buildUrl(path, query);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Crehana API ${response.status} ${path}: ${errorText}`);
        throw new Error(`Crehana API error ${response.status}: ${errorText}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      // Errores de red: traducir a mensajes legibles
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Timeout (${REQUEST_TIMEOUT_MS}ms) llamando a Crehana ${path}. Verifica tu conexión y que no haya un proxy bloqueando.`);
        }
        const cause = (error as Error & { cause?: { code?: string } }).cause;
        if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT' || cause?.code === 'ENOTFOUND' || cause?.code === 'ECONNREFUSED') {
          throw new Error(`No se pudo conectar a Crehana (${cause.code}). Verifica tu conexión a internet o configuración de proxy.`);
        }
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // =====================================================
  // USUARIOS
  // =====================================================

  /**
   * Listar usuarios de la organización.
   * Paginado por offset/limit. Limit máximo: 100.
   */
  async listUsers(params?: {
    limit?: number;
    offset?: number;
    status?: string;
    search?: string;
  }): Promise<CrehanaOffsetPaginated<CrehanaUserOrganization>> {
    return this.request<CrehanaOffsetPaginated<CrehanaUserOrganization>>(
      '/users/user-organizations/',
      params,
    );
  }

  /**
   * Iterador que recorre todas las páginas de usuarios automáticamente.
   * Útil para sync masivo.
   */
  async *iterateUsers(pageSize = 100): AsyncGenerator<CrehanaUserOrganization> {
    let offset = 0;
    while (true) {
      // El endpoint de users rechaza offset=0 con HTTP 400. Omitirlo para la primera página.
      const page = await this.listUsers({
        limit: pageSize,
        offset: offset > 0 ? offset : undefined,
      });
      for (const user of page.results) yield user;
      offset += page.results.length;
      if (offset >= page.total || page.results.length === 0) break;
    }
  }

  // =====================================================
  // CATÁLOGOS DE CURSOS (cursor pagination)
  // =====================================================

  /** Catálogo Elevate: cursos propios de la organización. */
  async listElevateCatalog(params?: {
    first?: number;
    after?: string;
  }): Promise<CrehanaCursorPaginated<CrehanaCatalogContent>> {
    return this.request<CrehanaCursorPaginated<CrehanaCatalogContent>>(
      '/learning/content/knowledge-hub/catalog/elevate/',
      params,
    );
  }

  /** Catálogo Crehana: cursos del marketplace de Crehana. */
  async listCrehanaCatalog(params?: {
    first?: number;
    after?: string;
  }): Promise<CrehanaCursorPaginated<CrehanaCatalogContent>> {
    return this.request<CrehanaCursorPaginated<CrehanaCatalogContent>>(
      '/learning/content/knowledge-hub/catalog/crehana/',
      params,
    );
  }

  // =====================================================
  // REPORTES
  // =====================================================

  /**
   * Reporte general: una fila por (usuario, curso) con progreso, fechas y certificados.
   * Es la fuente de verdad para mostrar el progreso de cada colaborador.
   */
  async listGeneralReport(params?: {
    limit?: number;
    offset?: number;
    user_id?: string;
    user_email?: string;
    user_status?: string;
    course_id?: string;
  }): Promise<CrehanaOffsetPaginated<CrehanaGeneralReportRow>> {
    return this.request<CrehanaOffsetPaginated<CrehanaGeneralReportRow>>(
      '/reports/learning/general/',
      params,
    );
  }

  async *iterateGeneralReport(
    pageSize = 100,
    filters?: { user_id?: string; user_email?: string; user_status?: string; course_id?: string },
  ): AsyncGenerator<CrehanaGeneralReportRow> {
    let offset = 0;
    while (true) {
      // Por consistencia con users, omitimos offset=0 para la primera página.
      const page = await this.listGeneralReport({
        limit: pageSize,
        offset: offset > 0 ? offset : undefined,
        ...filters,
      });
      for (const row of page.results) yield row;
      offset += page.results.length;
      if (offset >= page.total || page.results.length === 0) break;
    }
  }

  /** Reporte performance: una fila por usuario con totales agregados. */
  async listPerformanceReport(params?: {
    limit?: number;
    offset?: number;
    user_id?: string;
    user_email?: string;
    user_status?: string;
  }): Promise<CrehanaOffsetPaginated<CrehanaPerformanceReportRow>> {
    return this.request<CrehanaOffsetPaginated<CrehanaPerformanceReportRow>>(
      '/reports/learning/performance/',
      params,
    );
  }

  async *iteratePerformanceReport(
    pageSize = 100,
  ): AsyncGenerator<CrehanaPerformanceReportRow> {
    let offset = 0;
    while (true) {
      // Por consistencia con users, omitimos offset=0 para la primera página.
      const page = await this.listPerformanceReport({
        limit: pageSize,
        offset: offset > 0 ? offset : undefined,
      });
      for (const row of page.results) yield row;
      offset += page.results.length;
      if (offset >= page.total || page.results.length === 0) break;
    }
  }

  // =====================================================
  // UTILIDADES
  // =====================================================

  /**
   * Verifica que las credenciales y el slug funcionen.
   * Devuelve el total de usuarios + total de inscripciones detectadas.
   *
   * Las llamadas se hacen en SECUENCIA (no en paralelo) para que la primera
   * establezca la conexión TLS/HTTP-keepalive y la segunda la reuse.
   * Algunas redes/proxys tienen problemas con dos conexiones nuevas
   * abriéndose al mismo host simultáneamente.
   */
  async testConnection(): Promise<{
    success: boolean;
    organization_slug: string;
    users_total: number;
    enrollments_total: number;
  }> {
    this.ensureConfigured();
    const users = await this.listUsers({ limit: 1 });
    const general = await this.listGeneralReport({ limit: 1 });
    return {
      success: true,
      organization_slug: this.config!.organization_slug,
      users_total: users.total,
      enrollments_total: general.total,
    };
  }
}
