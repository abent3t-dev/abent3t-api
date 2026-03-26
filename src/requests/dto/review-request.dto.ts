import { IsIn, IsNotEmpty, IsString, IsOptional, MaxLength } from 'class-validator';

export class ReviewRequestDto {
  @IsString()
  @IsIn(['aprobada', 'rechazada'])
  @IsNotEmpty()
  status: 'aprobada' | 'rechazada';

  @IsString()
  @IsOptional()
  @MaxLength(500)
  rejection_reason?: string;
}
