import { IsNotEmpty, IsOptional, IsString, IsIn } from 'class-validator';

export class VerifyEvidenceDto {
  @IsIn(['approved', 'rejected'])
  @IsNotEmpty()
  verification_status: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  rejection_reason?: string;
}
