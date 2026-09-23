import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export const ERP_ALIAS_SYSTEMS = ['sap', 'maximo'] as const;
export type ErpAliasSystem = (typeof ERP_ALIAS_SYSTEMS)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateErpAliasDto {
  @IsIn(ERP_ALIAS_SYSTEMS)
  system!: ErpAliasSystem;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  code!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  display_name!: string;

  @IsOptional()
  @IsUUID()
  profile_id?: string | null;
}

export class UpdateErpAliasDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  display_name?: string;

  /** null = desligar del perfil. */
  @IsOptional()
  @IsUUID()
  profile_id?: string | null;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class ErpAliasQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(ERP_ALIAS_SYSTEMS)
  system?: ErpAliasSystem;
}

/** Importación: `system` global del archivo (el archivo puede traerlo por fila). */
export class ImportErpAliasDto {
  @IsOptional()
  @IsIn(ERP_ALIAS_SYSTEMS)
  system?: ErpAliasSystem;
}
