import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/** Fase §16 — Rechazo: justificación obligatoria (regla 4, mínimo 10). */
export class RejectCommitteeDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(2000)
  justification: string;
}
