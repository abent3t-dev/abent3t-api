import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsNumber,
  IsIn,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateCourseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsUUID()
  @IsOptional()
  institution_id?: string;

  @IsUUID()
  @IsOptional()
  course_type_id?: string;

  @IsUUID()
  @IsOptional()
  modality_id?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  total_hours?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  cost?: number;

  @IsString()
  @IsIn(['pending', 'paid', 'cancelled', 'na'])
  @IsOptional()
  payment_status?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
