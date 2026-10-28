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

  /** Solo quienes tienen este rol de FP&A (B2: firmantes). */
  @IsOptional()
  @IsIn(['fpa_area', 'fpa_planeacion', 'fpa_cfo'])
  rol?: 'fpa_area' | 'fpa_planeacion' | 'fpa_cfo';
}

export class FpaCreateAreaDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(120)
  name: string;
}

/** POST /fpa/firmantes (B2): titular de planeación o del CFO. */
export class FpaAssignSignerDto {
  @IsIn(['planeacion', 'cfo'], {
    message: 'El firmante es de planeación o del CFO',
  })
  duty: 'planeacion' | 'cfo';

  @IsUUID('all', { message: 'Elige a la persona del directorio' })
  profile_id: string;
}

export class FpaAssignDto {
  @IsUUID()
  area_id: string;

  @IsIn(['captura', 'aprobacion'])
  duty: 'captura' | 'aprobacion';

  @IsUUID()
  profile_id: string;
}
