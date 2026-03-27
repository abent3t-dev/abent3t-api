import { IsString, IsOptional, IsIn, MaxLength } from 'class-validator';

export class ReviewProposalDto {
  /**
   * Nuevo estado de la propuesta
   */
  @IsString()
  @IsIn(['en_investigacion', 'aprobada', 'rechazada'])
  status: 'en_investigacion' | 'aprobada' | 'rechazada';

  /**
   * Notas de revisión (visible para el solicitante)
   */
  @IsString()
  @IsOptional()
  @MaxLength(500)
  review_notes?: string;

  /**
   * Motivo de rechazo (requerido si status = rechazada)
   */
  @IsString()
  @IsOptional()
  @MaxLength(500)
  rejection_reason?: string;
}
