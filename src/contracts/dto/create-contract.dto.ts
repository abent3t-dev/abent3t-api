import {
  IsDateString,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const CONTRACT_DOCUMENT_TYPES = [
  'contrato',
  'addenda',
  'convenio',
  'carta_compromiso',
  'otro',
] as const;

export const CONTRACT_STATUSES = [
  'vigente',
  'vencido',
  'renovado',
  'cancelado',
] as const;

/** Fase §15 — Alta de contrato (metadata; el PDF se sube por separado). */
export class CreateContractDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  contract_number: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  tomo?: string;

  @IsIn(CONTRACT_DOCUMENT_TYPES)
  document_type: (typeof CONTRACT_DOCUMENT_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  service_description: string;

  @IsUUID()
  @IsNotEmpty()
  supplier_id: string;

  @IsDateString()
  @IsNotEmpty()
  start_date: string;

  @IsDateString()
  @IsNotEmpty()
  end_date: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  total_amount?: number;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  currency?: string;

  @IsUUID()
  @IsOptional()
  buyer_profile_id?: string;

  @IsEmail()
  @IsOptional()
  responsible_user_email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  responsible_user_name?: string;

  @IsIn(CONTRACT_STATUSES)
  @IsOptional()
  status?: (typeof CONTRACT_STATUSES)[number];

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}
