import {
  IsString,
  IsNumber,
  IsUUID,
  IsOptional,
  Min,
  MaxLength,
} from 'class-validator';

export class CreateNoDeducibleDto {
  @IsUUID()
  department_id: string;

  @IsString()
  @MaxLength(7)
  periodo: string; // Ej: "2026-04" (formato YYYY-MM)

  @IsString()
  @MaxLength(255)
  concepto: string;

  @IsNumber()
  @Min(0)
  monto: number;

  @IsString()
  @MaxLength(36)
  @IsOptional()
  cfdi_uuid?: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  notes?: string;
}
