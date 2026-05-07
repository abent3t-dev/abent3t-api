import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export const PERSONNEL_ROLES = ['colaborador', 'jefe_area'] as const;
export type PersonnelRole = (typeof PERSONNEL_ROLES)[number];

/**
 * password y full_name son OPCIONALES a nivel del DTO porque el endpoint
 * acepta dos modos:
 *  - Email nuevo → el service valida que ambos estén presentes y password
 *    cumpla la longitud mínima (validación condicional en el service).
 *  - Email ya registrado → solo se agrega el rol al usuario existente,
 *    no se modifican datos sensibles (password, nombre).
 */
export class CreatePersonnelDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsOptional()
  @MinLength(6)
  password?: string;

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
