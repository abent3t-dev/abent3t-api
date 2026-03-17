import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class UpdateCourseTypeDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
