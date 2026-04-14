import {
  IsString,
  IsOptional,
  IsUUID,
  IsNumber,
  IsBoolean,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateCourseDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

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
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
