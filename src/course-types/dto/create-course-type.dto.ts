import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class CreateCourseTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  key: string;

  @IsString()
  @IsOptional()
  description?: string;
}
