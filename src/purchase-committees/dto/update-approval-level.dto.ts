import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Roles que pueden ocupar un nivel de la cadena (§17 APPROVERS_COMITE + equipo). */
export const LEVEL_ASSIGNABLE_ROLES = [
  'lider_procura',
  'coordinador_compras',
  'comprador',
  'aprobador_nivel_1',
  'aprobador_nivel_2',
  'aprobador_nivel_3',
  'director_general',
] as const;

/**
 * Fase §16 (A5) — Edición del mapeo data-driven (§20.A.5). `profile_id: null`
 * explícito limpia el usuario específico y el nivel vuelve a resolverse por rol.
 */
export class UpdateApprovalLevelDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orden?: number;

  @IsIn(LEVEL_ASSIGNABLE_ROLES)
  @IsOptional()
  role?: (typeof LEVEL_ASSIGNABLE_ROLES)[number];

  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  @IsOptional()
  profile_id?: string | null;

  @IsBoolean()
  @IsOptional()
  confirmed?: boolean;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  notes?: string;
}
