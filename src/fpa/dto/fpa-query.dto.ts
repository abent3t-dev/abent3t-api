import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class FpaVersionQueryDto {
  @IsUUID()
  version_id: string;
}

export class FpaConsolidatedQueryDto {
  @IsUUID()
  version_id: string;

  @IsOptional()
  @IsIn(['area', 'categoria', 'area_categoria'])
  agrupar?: 'area' | 'categoria' | 'area_categoria';
}

export class FpaDirectoryQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class FpaCreateAreaDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(120)
  name: string;
}

export class FpaAssignDto {
  @IsUUID()
  area_id: string;

  @IsIn(['captura', 'aprobacion'])
  duty: 'captura' | 'aprobacion';

  @IsUUID()
  profile_id: string;
}
