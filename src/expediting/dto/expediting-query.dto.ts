import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { ColumnFilterablePaginationDto } from '../../common/column-filters/column-query.dto';

export const DERIVED_STATUSES = [
  'sin_fecha',
  'en_tiempo',
  'en_riesgo',
  'retrasada',
  'parcial',
  'entregada',
] as const;

/**
 * Fase Expeditación — Filtros del listado. `search` (número de PO o razón
 * social), `page`/`limit` de PaginationDto. `status` filtra por el estatus
 * DERIVADO (se aplica tras derivar, no en SQL). E1 (2026-09-25): filtros
 * por columna `filters`/`sort`/`order` (y `column`/`facet_search` en /facets).
 */
export class ExpeditingQueryDto extends ColumnFilterablePaginationDto {
  @IsIn(DERIVED_STATUSES)
  @IsOptional()
  status?: (typeof DERIVED_STATUSES)[number];

  @IsUUID()
  @IsOptional()
  buyer_id?: string;

  @IsUUID()
  @IsOptional()
  supplier_id?: string;

  @IsISO8601()
  @IsOptional()
  expected_from?: string;

  @IsISO8601()
  @IsOptional()
  expected_to?: string;

  /** Sprint 2026-09-22 (B6): acotar a una fuente. Default: las tres. */
  @IsIn(['abent', 'sap', 'maximo'])
  @IsOptional()
  source?: 'abent' | 'sap' | 'maximo';
}
