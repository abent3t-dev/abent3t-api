import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class UpdateDepartmentDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
