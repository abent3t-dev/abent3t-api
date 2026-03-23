import { IsUUID, IsNotEmpty, IsArray } from 'class-validator';

export class BulkEnrollmentDto {
  @IsUUID()
  @IsNotEmpty()
  course_edition_id: string;

  @IsArray()
  @IsUUID('4', { each: true })
  profile_ids: string[];
}
