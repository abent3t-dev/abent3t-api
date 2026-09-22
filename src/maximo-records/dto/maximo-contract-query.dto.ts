import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { toStatusList } from '../../sap-records/dto/sap-doc-query.dto';

/**
 * Fase INT-5 — Filtros del listado de contratos de Maximo (vista actual).
 * `search` busca en prnum/contractnum/vendor_name (staging no tiene columna
 * description de contrato — desviación documentada en el cierre de fase).
 */
export class MaximoContractQueryDto extends PaginationDto {
  /** Uno o varios estatus separados por coma (A5: multi-selección). */
  @IsOptional()
  @Transform(({ value }) => toStatusList(value))
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  status?: string[];

  @IsOptional()
  @IsIn(['true', 'false'])
  has_contract?: 'true' | 'false';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  vendor_name?: string;

  @IsOptional()
  @IsISO8601()
  end_from?: string;

  @IsOptional()
  @IsISO8601()
  end_to?: string;
}
