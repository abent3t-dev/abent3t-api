import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ColumnFilterablePaginationDto } from '../../common/column-filters/column-query.dto';
import { CONTRACT_STATUSES } from './create-contract.dto';

/**
 * Fase §15 — Filtros del listado de contratos. `search` (número de contrato,
 * servicio o razón social del proveedor), `page` y `limit` vienen de
 * PaginationDto. `vence_en_dias` acota a contratos cuyo fin cae entre hoy
 * (CDMX) y hoy + N días. E1 (2026-09-25): filtros por columna
 * (`filters`/`sort`/`order`, y `column`/`facet_search` en /facets).
 * I6 (2026-09-30): `sin_fin=true` = documentos sin fecha de fin;
 * `group=carpeta` = una fila por carpeta con sus documentos.
 */
export class ContractQueryDto extends ColumnFilterablePaginationDto {
  @IsIn(CONTRACT_STATUSES)
  @IsOptional()
  status?: (typeof CONTRACT_STATUSES)[number];

  @IsUUID()
  @IsOptional()
  supplier_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  vence_en_dias?: number;

  @IsIn(['true', 'false'])
  @IsOptional()
  sin_fin?: 'true' | 'false';

  @IsIn(['carpeta'])
  @IsOptional()
  group?: 'carpeta';
}
