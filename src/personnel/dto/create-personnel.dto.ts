import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export const PERSONNEL_ROLES = ['colaborador', 'jefe_area'] as const;
export type PersonnelRole = (typeof PERSONNEL_ROLES)[number];

export class CreatePersonnelDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsString()
  @IsNotEmpty()
  full_name: string;

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
