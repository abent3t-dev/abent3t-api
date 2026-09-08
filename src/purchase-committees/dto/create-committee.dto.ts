import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Fase §16 — Alta del comité (metadata; el PPT va por /versions). */
export class CreateCommitteeDto {
  @IsDateString()
  @IsNotEmpty()
  committee_date: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;
}
