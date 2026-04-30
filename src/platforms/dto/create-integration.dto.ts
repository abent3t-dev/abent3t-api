import {
  IsUUID,
  IsEnum,
  IsString,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUrl,
  Min,
  Max,
} from 'class-validator';

export enum PlatformType {
  CREHANA = 'crehana',
  UDEMY_BUSINESS = 'udemy_business',
  LINKEDIN_LEARNING = 'linkedin_learning',
  COURSERA = 'coursera',
  OTHER = 'other',
}

export class CreateIntegrationDto {
  @IsUUID()
  institution_id: string;

  @IsEnum(PlatformType)
  platform_type: PlatformType;

  @IsOptional()
  @IsUrl()
  api_url?: string;

  @IsOptional()
  @IsString()
  organization_slug?: string;

  @IsOptional()
  @IsString()
  public_key?: string;

  @IsOptional()
  @IsString()
  private_key?: string; // Se encriptará antes de guardar

  @IsOptional()
  @IsBoolean()
  sync_enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168) // Máximo 1 semana
  sync_frequency_hours?: number;

  @IsOptional()
  @IsBoolean()
  sso_enabled?: boolean;

  @IsOptional()
  @IsString()
  sso_type?: string; // 'saml2' | 'microsoft'

  @IsOptional()
  sso_config?: Record<string, unknown>;
}
