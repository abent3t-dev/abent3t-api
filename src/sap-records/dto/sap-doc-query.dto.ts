import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsYearQuery } from '../../common/dto/year-query.util';
import { ColumnFilterablePaginationDto } from '../../common/column-filters/column-query.dto';

/** Estatus derivados legibles (A6): `cancelled` no es un DocumentStatus de SAP. */
export const SAP_DOC_STATUS_KEYS = ['open', 'close', 'cancelled'] as const;
export type SapDocStatusKey = (typeof SAP_DOC_STATUS_KEYS)[number];

/**
 * Convierte `status=open,close` (o repetido) en arreglo (A5: multi-selección).
 * Cada valor se valida contra la lista de estatus derivados.
 */
export function toStatusList(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [value];
  const parts = raw
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v !== '');
  return parts.length ? Array.from(new Set(parts)) : undefined;
}

/**
 * Query de los listados GET /sap/purchase-orders|purchase-requests (y de sus
 * exports). `status` acepta uno o varios alias separados por coma
 * (`open`, `close`, `cancelled`); el service los traduce al ERP.
 * `page`/`limit`/`search` (número de documento o proveedor/solicitante) y
 * los filtros por columna (E1: `filters`/`sort`/`order`) vienen de la base.
 */
export class SapDocQueryDto extends ColumnFilterablePaginationDto {
  @IsOptional()
  @Transform(({ value }) => toStatusList(value))
  @IsIn(SAP_DOC_STATUS_KEYS, { each: true })
  status?: SapDocStatusKey[];

  /** Rango sobre doc_date (fecha del documento). */
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  /** D4 (2026-09-23): año calendario de doc_date. */
  @IsYearQuery()
  year?: number;

  /**
   * D1 (2026-09-23), solo OC: `sap` = capturadas en SAP; `maximo` = creadas
   * por la integración desde Maximo (NumAtCard = PONUM).
   */
  @IsOptional()
  @IsIn(['sap', 'maximo'])
  origin?: 'sap' | 'maximo';
}
