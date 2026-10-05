import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import {
  AVANCE_REPORTES,
  type AvanceReporte,
} from '../avance-semanal/avance-semanal.engine';
import {
  AVANCE_CORTES,
  AVANCE_INICIOS,
  AVANCE_MONTOS_FUENTES,
  type AvanceCorte,
  type AvanceInicio,
  type AvanceMontosFuente,
} from '../avance-semanal/avance-semanal.reglas';

/**
 * H1 — Reporte de avance semanal. `semana` = cualquier día de la semana (se
 * toma su lunes; default: la última semana completa). `desde`/`hasta` = una
 * página por semana (el "acumulado"). I3: `fuente` default `ambos` (una
 * página de Maximo y una de SAP por semana); `maximo`, `sap` o `todas` (las
 * dos sumadas, solo API) dan una página por semana.
 */
export class AvanceSemanalDto {
  @IsISO8601()
  @IsOptional()
  semana?: string;

  @IsISO8601()
  @IsOptional()
  desde?: string;

  @IsISO8601()
  @IsOptional()
  hasta?: string;

  @IsIn(AVANCE_REPORTES)
  @IsOptional()
  fuente?: AvanceReporte;
}

/**
 * K5.7 — Conciliación contra la serie de Jorge con una variante de las
 * reglas. Todo opcional: lo que no viene toma el default (`AVANCE_REGLAS` y
 * `AVANCE_MONTOS_FUENTE_MAXIMO`).
 */
export class AvanceConciliacionDto {
  /** Recibida de Maximo: primer APPR o ISSUEDATE. */
  @IsIn(AVANCE_INICIOS)
  @IsOptional()
  recibida?: AvanceInicio;

  /** Inicio de los días de cierre y cancelación de Maximo. */
  @IsIn(AVANCE_INICIOS)
  @IsOptional()
  dias_desde?: AvanceInicio;

  /** OC de la página de Maximo: las suyas o las de SAP migradas. */
  @IsIn(AVANCE_MONTOS_FUENTES)
  @IsOptional()
  montos?: AvanceMontosFuente;

  /** Corte de la semana: domingo o viernes (23:59 hora de México). */
  @IsIn(AVANCE_CORTES)
  @IsOptional()
  corte?: AvanceCorte;
}
