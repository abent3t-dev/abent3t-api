import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsIn,
  MaxLength,
} from 'class-validator';

export class UpdateInstitutionDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @IsString()
  @IsOptional()
  @IsIn(['external', 'platform', 'internal'])
  type?: string;

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

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
