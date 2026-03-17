import {
  IsString,
  IsNotEmpty,
  IsBoolean,
  IsOptional,
  IsNumber,
  IsIn,
  MaxLength,
} from 'class-validator';

export class CreateInstitutionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsString()
  @IsIn(['external', 'platform', 'internal'])
  type: string;

  @IsBoolean()
  @IsOptional()
  is_platform?: boolean;

  @IsNumber()
  @IsOptional()
  annual_cost?: number;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  platform_url?: string;
}
