import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PERSONNEL_ROLES } from './create-personnel.dto';
import type { PersonnelRole } from './create-personnel.dto';

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

  @IsIn(PERSONNEL_ROLES)
  @IsOptional()
  role?: PersonnelRole;
}
