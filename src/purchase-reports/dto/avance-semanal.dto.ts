import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import {
  AVANCE_REPORTES,
  type AvanceReporte,
} from '../avance-semanal/avance-semanal.engine';

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
