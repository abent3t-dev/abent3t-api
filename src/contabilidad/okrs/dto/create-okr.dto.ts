import {
  IsString,
  IsNumber,
  IsEnum,
  IsDateString,
  IsUUID,
  IsOptional,
  Min,
  MaxLength,
} from 'class-validator';

// Enum matching DB: okr_type ('objective', 'key_result')
export enum OkrType {
  OBJECTIVE = 'objective',
  KEY_RESULT = 'key_result',
}

export class CreateOkrDto {
  @IsEnum(OkrType)
  tipo: OkrType;

  @IsString()
  @MaxLength(255)
  titulo: string;

  @IsString()
  @MaxLength(1000)
  @IsOptional()
  descripcion?: string;

  @IsString()
  @MaxLength(20)
  periodo: string; // Ej: "Q1-2026", "2026"

  @IsUUID()
  @IsOptional()
  parent_okr_id?: string; // Para key_results, referencia al objetivo padre

  @IsNumber()
  @Min(0)
  @IsOptional()
  target_value?: number; // Meta numérica (para KRs medibles)

  @IsNumber()
  @Min(0)
  @IsOptional()
  current_value?: number; // Valor actual

  @IsString()
  @MaxLength(50)
  @IsOptional()
  unit?: string; // %, dias, pesos, etc.

  @IsDateString()
  @IsOptional()
  due_date?: string;
}
