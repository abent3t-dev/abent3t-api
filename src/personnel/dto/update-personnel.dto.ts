import { IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdatePersonnelDto {
  @IsString()
  @IsOptional()
  full_name?: string;

  @IsString()
  @IsOptional()
  position?: string;

  @IsUUID()
  @IsOptional()
  department_id?: string;
}
