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
 * K4.4 (2026-10-05): la misma ruta sirve a Solicitudes con `vista=solicitudes`
 * (una fila por PR); `status` sigue siendo el estatus del contrato.
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

  /**
   * D4 (2026-09-23): año calendario. Contratos: fecha en Maximo
   * (created_at_source). K4.4, con `vista=solicitudes`: creación de la PR
   * (`pr_issue_date`) o, con `sin_oc`/`contrato_sin_oc`, su llegada a
   * Compras (primer APPR), como la tarjeta de pendientes.
   */
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
   * K4.4 (2026-10-05): `solicitudes` = una fila por PR (`CURRENT_MAXIMO_PRS`)
   * con el estatus y las fechas DE LA PR. Sin ella, Contratos y el agrupado
   * quedan como antes (vista de contratos, `year` por created_at_source).
   * `sin_oc`, `contrato_sin_oc`, `en_aprobacion` y `pr_status` la implican.
   */
  @IsOptional()
  @IsIn(['solicitudes'])
  vista?: 'solicitudes';

  /**
   * G3 (2026-09-28) / K4: `true` = PR pendientes de gestionar: aprobadas
   * (APPR) sin contrato ni OC vigente que las use. Con `year` o `pr_desde`,
   * el periodo va por la llegada a Compras (primer APPR).
   */
  @IsOptional()
  @IsIn(['true'])
  sin_oc?: 'true';

  /**
   * G3: PR desde esta fecha: llegada a Compras con `sin_oc` o
   * `contrato_sin_oc`; si no, creación de la PR (solo `vista=solicitudes`).
   */
  @IsOptional()
  @IsISO8601()
  pr_desde?: string;

  /**
   * I8 (2026-09-30) / K4: `true` = PR DE CONTRATO aprobada (APPR) sin OC
   * vigente (la OC se genera en automático): aparte de las pendientes de
   * gestionar. Mismo periodo.
   */
  @IsOptional()
  @IsIn(['true'])
  contrato_sin_oc?: 'true';

  /**
   * K4.4: `true` = PR en aprobación (WAPPR): todavía no llegan a Compras.
   * Con `year`, por la creación de la PR.
   */
  @IsOptional()
  @IsIn(['true'])
  en_aprobacion?: 'true';

  /** K4.4: uno o varios estatus DE LA PR (WAPPR, APPR, CLOSE, CAN), con coma. */
  @IsOptional()
  @Transform(({ value }) => toStatusList(value))
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  pr_status?: string[];
}

/**
 * K4.4: ¿la consulta es de la vista de solicitudes (una fila por PR)? Con
 * `vista=solicitudes` o con un filtro que solo existe ahí.
 */
export function isMaximoRequestsView(query: MaximoContractQueryDto): boolean {
  return (
    query.vista === 'solicitudes' ||
    query.sin_oc === 'true' ||
    query.contrato_sin_oc === 'true' ||
    query.en_aprobacion === 'true' ||
    (query.pr_status?.length ?? 0) > 0
  );
}
