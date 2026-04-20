import {
  IsNumber,
  IsDateString,
  IsOptional,
  Min,
  MaxLength,
  IsString,
} from 'class-validator';

export class CreatePerdidaFiscalDto {
  @IsNumber()
  ejercicio: number; // Ej: 2024

  @IsDateString()
  fecha_declaracion: string;

  @IsNumber()
  @Min(0)
  monto_original: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  factor_actualizacion?: number;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  notes?: string;
}
