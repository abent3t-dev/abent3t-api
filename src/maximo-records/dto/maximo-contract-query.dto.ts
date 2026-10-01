import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ColumnFilterablePaginationDto } from '../../common/column-filters/column-query.dto';
import { toStatusList } from '../../sap-records/dto/sap-doc-query.dto';
import { IsYearQuery } from '../../common/dto/year-query.util';

/**
 * Fase INT-5 — Filtros del listado de contratos de Maximo (vista actual).
 * `search` busca en prnum/contractnum/vendor_name (staging no tiene columna
 * description de contrato — desviación documentada en el cierre de fase).
 */
export class MaximoContractQueryDto extends ColumnFilterablePaginationDto {
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

  /** D4 (2026-09-23): año calendario de la fecha en Maximo (created_at_source). */
  @IsYearQuery()
  year?: number;

  /**
   * E2 (2026-09-25): `contract` = una fila por contrato (última revisión)
   * con sus PR, en lugar de una fila por PR.
   */
  @IsOptional()
  @IsIn(['contract'])
  group?: 'contract';

  /** G1 (2026-09-28): proveedor efectivo (`sap:P0000323` / `maximo:P0000544`). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  proveedor?: string;

  /**
   * G3 (2026-09-28): `true` = PR pendientes de gestionar (sin contrato y
   * sin OC vigente que las use). Con `year` o `pr_desde`, el periodo se
   * ubica por folio (AB_CONTRATOS no expone la fecha de la PR).
   */
  @IsOptional()
  @IsIn(['true'])
  sin_oc?: 'true';

  /** G3: PR creadas desde esta fecha (ubicadas por folio). */
  @IsOptional()
  @IsISO8601()
  pr_desde?: string;

  /**
   * I8 (2026-09-30): `true` = PR DE CONTRATO sin OC vigente (la OC se genera
   * en automático): aparte de las pendientes de gestionar. Mismo periodo.
   */
  @IsOptional()
  @IsIn(['true'])
  contrato_sin_oc?: 'true';
}
