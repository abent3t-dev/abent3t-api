import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export const COMMITTEE_STATUSES = [
  'borrador',
  'en_aprobacion',
  'aprobado',
  'rechazado',
  'cancelado',
] as const;

/** Fase §16 — Filtros del listado (status, fecha, autor + search/page). */
export class CommitteeQueryDto extends PaginationDto {
  @IsIn(COMMITTEE_STATUSES)
  @IsOptional()
  status?: (typeof COMMITTEE_STATUSES)[number];

  @IsISO8601()
  @IsOptional()
  date_from?: string;

  @IsISO8601()
  @IsOptional()
  date_to?: string;

  @IsUUID()
  @IsOptional()
  created_by?: string;
}
