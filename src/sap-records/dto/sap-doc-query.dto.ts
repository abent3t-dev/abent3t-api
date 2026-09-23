import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { IsYearQuery } from '../../common/dto/year-query.util';

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
 */
export class SapDocQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Busca por número de documento o por proveedor/solicitante. */
  @IsOptional()
  @MaxLength(100)
  search?: string;

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
