import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../dto/pagination.dto';

/**
 * E1 (2026-09-25) — Parámetros del filtro "tipo Excel" que comparten los
 * listados de Compras, sus exports y sus `/facets` (ver column-filters.ts).
 * `column` y `facet_search` solo los usa `/facets`.
 */
export class ColumnFilterablePaginationDto extends PaginationDto {
  /** JSON por columna: {"proveedor":{"in":["A"]},"dias":{"min":-400}}. */
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  filters?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  sort?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  /** `/facets`: columna de la que se piden los valores. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  column?: string;

  /** `/facets`: texto para acotar los valores (más de 200 distintos). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  facet_search?: string;
}
