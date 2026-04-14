import {
  IsString,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsIn,
  MaxLength,
  Min,
} from 'class-validator';
import { IsAfter } from '../../common/validators/is-after.validator';
import type { EditionPaymentStatus } from './create-course-edition.dto';

export class UpdateCourseEditionDto {
  @IsDateString()
  @IsOptional()
  start_date?: string;

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
  is_active?: boolean;

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
  cost_override?: number | null;

  @IsString()
  @IsIn(['pending', 'paid', 'cancelled', 'na'])
  @IsOptional()
  payment_status?: EditionPaymentStatus;

  @IsString()
  @MaxLength(255)
  @IsOptional()
  payment_reference?: string | null;

  @IsDateString()
  @IsOptional()
  payment_date?: string | null;
}
