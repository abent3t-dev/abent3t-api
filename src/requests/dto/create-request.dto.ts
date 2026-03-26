import { IsUUID, IsNotEmpty, IsString, IsOptional, MaxLength } from 'class-validator';

export class CreateRequestDto {
  @IsUUID()
  @IsNotEmpty()
  course_edition_id: string;

  @IsUUID()
  @IsNotEmpty()
  profile_id: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  request_reason?: string;
}
