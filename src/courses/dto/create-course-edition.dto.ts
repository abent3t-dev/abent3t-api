import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsInt,
  MaxLength,
  Min,
} from 'class-validator';
import { IsAfter } from '../../common/validators/is-after.validator';

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
}
