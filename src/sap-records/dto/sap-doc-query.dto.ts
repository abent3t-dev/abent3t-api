import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Query de los listados GET /sap/purchase-orders|purchase-requests.
 * `status` usa alias legibles; el service los traduce a los valores
 * bost_* del ERP.
 */
export class SapDocQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Busca por número de documento o por proveedor/solicitante. */
  @IsOptional()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['open', 'close'])
  status?: 'open' | 'close';

  /** Rango sobre doc_date (fecha del documento). */
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
