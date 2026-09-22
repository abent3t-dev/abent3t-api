import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { toStatusList } from '../../sap-records/dto/sap-doc-query.dto';

/**
 * Fase INT-5 — Filtros del listado de POs de Maximo (vista actual).
 * `search` (ponum/descripción), `page` y `limit` vienen de PaginationDto.
 */
export class MaximoPoQueryDto extends PaginationDto {
  /** Uno o varios estatus separados por coma (A5: multi-selección). */
  @IsOptional()
  @Transform(({ value }) => toStatusList(value))
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  status?: string[];

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
