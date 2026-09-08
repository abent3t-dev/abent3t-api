import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Nota de contacto/seguimiento con el proveedor. */
export class FollowUpDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}

/** Reprogramación de la fecha esperada (conserva historial y NO toca la PO). */
export class RescheduleDto {
  @IsDateString()
  @IsNotEmpty()
  new_expected_date: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(1000)
  reason: string;
}

/** Recepción total o parcial. */
export class ReceiptDto {
  @IsIn(['parcial', 'total'])
  type: 'parcial' | 'total';

  @IsDateString()
  @IsNotEmpty()
  received_date: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  comment?: string;
}
