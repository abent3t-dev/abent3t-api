import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { LEVEL_ASSIGNABLE_ROLES } from './update-approval-level.dto';

/**
 * H3 (2026-09-29) — Nuevo nivel al final de la cadena del comité. Por rol o
 * por persona (`profile_id`); nace sin confirmar hasta que Ingrid lo valide.
 */
export class CreateApprovalLevelDto {
  @IsIn(LEVEL_ASSIGNABLE_ROLES)
  role!: (typeof LEVEL_ASSIGNABLE_ROLES)[number];

  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  @IsOptional()
  profile_id?: string | null;

  @IsBoolean()
  @IsOptional()
  confirmed?: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  notes?: string;
}
