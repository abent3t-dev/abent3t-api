import { IsOptional, IsIn, IsString, IsBoolean } from 'class-validator';

export class UpdateEnrollmentDto {
  @IsOptional()
  @IsIn(['inscrito', 'en_curso', 'completo', 'pendiente_evidencia', 'cancelado'])
  status?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
