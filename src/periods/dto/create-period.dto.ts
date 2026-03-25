import {
  IsInt,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { IsAfter } from '../../common/validators/is-after.validator';

export class CreatePeriodDto {
  @IsInt()
  @IsNotEmpty()
  @Min(2020)
  @Max(2040)
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
  @IsAfter('start_date')
  end_date: string;
}
