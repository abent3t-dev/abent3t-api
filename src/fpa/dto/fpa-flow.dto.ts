import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * FP&A (B3) — enviar, aprobar, rechazar, retirar o reabrir un presupuesto.
 * La pantalla manda el estado y la ronda que tenía a la vista: si otra
 * persona ya lo movió, el API responde 409 con lo que pasó (o "ya hecho", si
 * fue la misma persona con la misma acción). Rechazar y reabrir piden
 * comentario de al menos 10 caracteres; lo revisa el service, con un mensaje
 * para cada caso.
 */

const BUDGET_STATUSES = [
  'borrador',
  'enviado',
  'aprobado_area',
  'aprobado_planeacion',
  'aprobado_cfo',
  'devuelto',
] as const;

const ROUND = { message: 'Falta la ronda que tenías en pantalla' };

export class FpaFlowActionDto {
  @IsIn(BUDGET_STATUSES, { message: 'Falta el estado que tenías en pantalla' })
  expected_status: (typeof BUDGET_STATUSES)[number];

  @Type(() => Number)
  @IsInt(ROUND)
  @Min(0, ROUND)
  @Max(32767, ROUND)
  expected_round: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : (value ?? null),
  )
  @ValidateIf((o: FpaFlowActionDto) => o.comment !== null)
  @IsString({ message: 'El comentario va en texto' })
  @MaxLength(1000, { message: 'El comentario lleva hasta 1,000 caracteres' })
  comment?: string | null;
}
