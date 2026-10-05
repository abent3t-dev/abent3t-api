import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { ColumnFilterablePaginationDto } from '../../common/column-filters/column-query.dto';

export const DERIVED_STATUSES = [
  'sin_fecha',
  'en_tiempo',
  'en_riesgo',
  'retrasada',
  'parcial',
  'entregada',
  'cancelada',
] as const;

/**
 * Fase Expeditación — Filtros del listado. `search` (número de PO u OC, o
 * razón social), `page`/`limit` de PaginationDto. `status` filtra por el
 * estatus DERIVADO (se aplica tras derivar, no en SQL). E1 (2026-09-25):
 * filtros por columna `filters`/`sort`/`order` (y `column`/`facet_search`
 * en /facets). Los parámetros nuevos se DECLARAN aquí: el ValidationPipe
 * (`whitelist`) descarta en silencio lo que no está declarado.
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

  /**
   * I1a (2026-09-30): solo las OC abiertas en SAP que ya están cerradas o
   * canceladas en Maximo — la lista para depurarlas en SAP.
   */
  @IsIn(['true', 'false'])
  @IsOptional()
  closed_in_maximo?: 'true' | 'false';

  /**
   * K1 (2026-10-05): solo las OC abiertas en SAP con recepción completa en
   * Maximo (I1b). Lista aparte de `closed_in_maximo`, que no cambia.
   */
  @IsIn(['true', 'false'])
  @IsOptional()
  received_in_maximo?: 'true' | 'false';

  /** K1: chip "Solo pendientes": sin entregadas ni canceladas. */
  @IsIn(['true'])
  @IsOptional()
  solo_pendientes?: 'true';
}
