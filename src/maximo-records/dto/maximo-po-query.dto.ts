import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

/**
 * Fase INT-5 — Filtros del listado de POs de Maximo (vista actual).
 * `search` (ponum/descripción), `page` y `limit` vienen de PaginationDto.
 */
export class MaximoPoQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(30)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  vendor_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  ab_clasfpo?: string;

  @IsOptional()
  @IsISO8601()
  approved_from?: string;

  @IsOptional()
  @IsISO8601()
  approved_to?: string;
}
