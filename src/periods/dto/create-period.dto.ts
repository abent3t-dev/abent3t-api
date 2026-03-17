import {
  IsInt,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
  MaxLength,
} from 'class-validator';

export class CreatePeriodDto {
  @IsInt()
  @IsNotEmpty()
  year: number;

  @IsInt()
  @IsOptional()
  @IsIn([1, 2])
  semester?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  label: string;

  @IsDateString()
  @IsNotEmpty()
  start_date: string;

  @IsDateString()
  @IsNotEmpty()
  end_date: string;
}
