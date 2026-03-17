import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class CreateModalityDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  key: string;

  @IsString()
  @IsOptional()
  description?: string;
}
