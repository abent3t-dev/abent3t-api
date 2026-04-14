import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsInt,
  IsBoolean,
  IsNumber,
  IsIn,
  MaxLength,
  Min,
} from 'class-validator';
import { IsAfter } from '../../common/validators/is-after.validator';

export type EditionPaymentStatus = 'pending' | 'paid' | 'cancelled' | 'na';

export class CreateCourseEditionDto {
  @IsDateString()
  @IsNotEmpty()
  start_date: string;

  @IsDateString()
  @IsOptional()
  @IsAfter('start_date')
  end_date?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  location?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  instructor?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  max_participants?: number;

  @IsBoolean()
  @IsOptional()
  prorate_cost?: boolean;

  @IsBoolean()
  @IsOptional()
  require_evidence_for_completion?: boolean;

  // Campos de costo y pago por edición
  @IsNumber()
  @Min(0)
  @IsOptional()
  cost_override?: number;

  @IsString()
  @IsIn(['pending', 'paid', 'cancelled', 'na'])
  @IsOptional()
  payment_status?: EditionPaymentStatus;

  @IsString()
  @MaxLength(255)
  @IsOptional()
  payment_reference?: string;

  @IsDateString()
  @IsOptional()
  payment_date?: string;
}
