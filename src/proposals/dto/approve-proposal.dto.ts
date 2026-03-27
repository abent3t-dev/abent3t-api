import {
  IsUUID,
  IsOptional,
  IsNumber,
  IsInt,
  IsString,
  IsDateString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * DTO para aprobar una propuesta y crear el curso.
 * admin_rh puede ajustar los datos verificados antes de crear el curso.
 */
export class ApproveProposalDto {
  /**
   * Nombre final del curso (verificado por admin_rh)
   */
  @IsString()
  @MaxLength(255)
  course_name: string;

  /**
   * ID de la institución (debe existir en el catálogo)
   */
  @IsUUID()
  institution_id: string;

  /**
   * ID del tipo de curso
   */
  @IsUUID()
  course_type_id: string;

  /**
   * ID de la modalidad
   */
  @IsUUID()
  modality_id: string;

  /**
   * Costo verificado del curso
   */
  @IsNumber()
  @Min(0)
  cost: number;

  /**
   * Horas totales del curso
   */
  @IsInt()
  @Min(0)
  total_hours: number;

  /**
   * Descripción del curso
   */
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  /**
   * Fecha de inicio de la edición
   */
  @IsDateString()
  start_date: string;

  /**
   * Fecha de fin de la edición
   */
  @IsDateString()
  @IsOptional()
  end_date?: string;

  /**
   * Ubicación o plataforma
   */
  @IsString()
  @IsOptional()
  @MaxLength(255)
  location?: string;

  /**
   * Instructor
   */
  @IsString()
  @IsOptional()
  @MaxLength(255)
  instructor?: string;

  /**
   * Notas de aprobación
   */
  @IsString()
  @IsOptional()
  @MaxLength(500)
  review_notes?: string;
}
