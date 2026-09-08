import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CONTRACT_STATUSES } from './create-contract.dto';

/**
 * Fase §15 — Filtros del listado de contratos. `search` (número de contrato,
 * servicio o razón social del proveedor), `page` y `limit` vienen de
 * PaginationDto. `vence_en_dias` acota a contratos cuyo fin cae entre hoy
 * (CDMX) y hoy + N días.
 */
export class ContractQueryDto extends PaginationDto {
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
}
