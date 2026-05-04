import {
  IsString,
  IsOptional,
  IsUUID,
  IsNumber,
  IsInt,
  IsUrl,
  IsDateString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateProposalDto {
  /**
   * ID del colaborador que tomará el curso.
   * Si no se especifica, se asume que es el mismo usuario que propone.
   */
  @IsUUID()
  @IsOptional()
  profile_id?: string;

  /**
   * Nombre del curso propuesto
   */
  @IsString()
  @MaxLength(255)
  course_name: string;

  /**
   * Nombre de la institución que ofrece el curso
   */
  @IsString()
  @IsOptional()
  @MaxLength(255)
  institution_name?: string;

  /**
   * URL del curso (página web, plataforma, etc.).
   * Es opcional. Si se proporciona, debe tener formato de URL válido
   * (http/https). Strings vacíos se ignoran.
   */
  @IsOptional()
  @ValidateIf((o) => o.course_url !== null && o.course_url !== '')
  @IsUrl({ require_protocol: true })
  course_url?: string;

  /**
   * Costo estimado del curso
   */
  @IsNumber()
  @IsOptional()
  @Min(0)
  estimated_cost?: number;

  /**
   * Horas estimadas del curso
   */
  @IsInt()
  @IsOptional()
  @Min(0)
  estimated_hours?: number;

  /**
   * Modalidad: presencial, virtual, hibrido
   */
  @IsString()
  @IsOptional()
  @MaxLength(50)
  modality?: string;

  /**
   * Fecha de inicio del curso
   */
  @IsDateString()
  @IsOptional()
  start_date?: string;

  /**
   * Fecha de fin del curso
   */
  @IsDateString()
  @IsOptional()
  end_date?: string;

  /**
   * Justificación: por qué necesita este curso
   */
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  justification?: string;
}
