import {
  IsString,
  IsDateString,
  IsArray,
  IsNumber,
  ValidateNested,
  IsOptional,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AccionistaDto {
  @IsString()
  @MaxLength(255)
  accionista_nombre: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  porcentaje: number;

  @IsString()
  @MaxLength(13)
  @IsOptional()
  rfc?: string;

  @IsString()
  @MaxLength(50)
  @IsOptional()
  tipo_accion?: string; // 'ordinaria', 'preferente', etc.

  @IsString()
  @MaxLength(500)
  @IsOptional()
  notes?: string;
}

export class CreateTenenciaDto {
  @IsDateString()
  effective_date: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  event_description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AccionistaDto)
  accionistas: AccionistaDto[];
}
