import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

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
 * DERIVADO (se aplica tras derivar, no en SQL).
 */
export class ExpeditingQueryDto extends PaginationDto {
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
}
