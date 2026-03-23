import { IsUUID, IsNotEmpty, IsOptional, IsIn, IsString } from 'class-validator';

export class CreateEnrollmentDto {
  @IsUUID()
  @IsNotEmpty()
  course_edition_id: string;

  @IsUUID()
  @IsNotEmpty()
  profile_id: string;

  @IsOptional()
  @IsIn(['inscrito', 'en_curso', 'completo', 'pendiente_evidencia', 'cancelado'])
  status?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
