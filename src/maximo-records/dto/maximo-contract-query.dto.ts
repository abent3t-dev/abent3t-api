import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

/**
 * Fase INT-5 — Filtros del listado de contratos de Maximo (vista actual).
 * `search` busca en prnum/contractnum/vendor_name (staging no tiene columna
 * description de contrato — desviación documentada en el cierre de fase).
 */
export class MaximoContractQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(30)
  status?: string;

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
