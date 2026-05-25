import { IsUUID, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateEnrollmentDto {
  @IsUUID()
  @IsNotEmpty()
  course_edition_id: string;

  @IsUUID()
  @IsNotEmpty()
  profile_id: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
