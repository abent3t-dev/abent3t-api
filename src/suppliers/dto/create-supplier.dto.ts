import {
  IsString,
  IsNotEmpty,
  IsEmail,
  IsOptional,
  IsBoolean,
  IsNumber,
  MaxLength,
  Min,
  Max,
} from 'class-validator';

export class CreateSupplierDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  legal_name: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  commercial_name?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  tax_id: string; // RFC

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  contact_name?: string;

  @IsEmail()
  @IsOptional()
  contact_email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  contact_phone?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  performance_score?: number;

  @IsBoolean()
  @IsOptional()
  is_blocked?: boolean;

  @IsString()
  @IsOptional()
  blocked_reason?: string;
}
