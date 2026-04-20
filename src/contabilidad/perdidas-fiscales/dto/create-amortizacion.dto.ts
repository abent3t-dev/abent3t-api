import {
  IsUUID,
  IsNumber,
  IsString,
  IsOptional,
  Min,
  MaxLength,
} from 'class-validator';

export class CreateAmortizacionDto {
  @IsUUID()
  fiscal_loss_id: string;

  @IsNumber()
  ejercicio_aplicacion: number; // Ej: 2025

  @IsNumber()
  @Min(0)
  monto_amortizado: number;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  notes?: string;
}
