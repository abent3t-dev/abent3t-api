import { IsUUID, IsNotEmpty, IsOptional, IsString, IsIn } from 'class-validator';

export class CreateEvidenceDto {
  @IsUUID()
  @IsNotEmpty()
  enrollment_id: string;

  @IsIn(['certificate', 'attendance', 'assessment', 'other'])
  @IsOptional()
  evidence_type?: string = 'certificate';

  @IsOptional()
  @IsString()
  notes?: string;
}
