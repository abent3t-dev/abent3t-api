import { IsOptional, IsString, IsIn } from 'class-validator';

export class UpdateEvidenceDto {
  @IsIn(['certificate', 'attendance', 'assessment', 'other'])
  @IsOptional()
  evidence_type?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
