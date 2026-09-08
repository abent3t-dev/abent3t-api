import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Fase Reportes — Rango del periodo. Defaults y tope los resuelve el service
 * (últimos 12 meses por default, máximo 24 — regla 5).
 */
export class ReportPeriodDto {
  @IsISO8601()
  @IsOptional()
  from?: string;

  @IsISO8601()
  @IsOptional()
  to?: string;
}
