import {
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  IsIn,
  IsDateString,
  MaxLength,
} from 'class-validator';

export class UpdatePeriodDto {
  @IsString()
  @IsOptional()
  @MaxLength(50)
  label?: string;

  @IsDateString()
  @IsOptional()
  start_date?: string;

  @IsDateString()
  @IsOptional()
  end_date?: string;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
