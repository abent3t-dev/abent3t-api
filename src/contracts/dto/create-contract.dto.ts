import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CONTRACT_DOC_KINDS,
  CONTRACT_USER_AREAS,
  type ContractDocKind,
} from '../contract-catalog';

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

/**
 * Fase §15 — Alta de contrato (metadata; el PDF se sube por separado).
 *
 * I6 (2026-09-30): el número se arma con la carpeta y el tipo (A3T-0003,
 * A3T-0003-CI, A3T-0003-E2…), igual que la carga del control de contratos;
 * `contract_number` explícito sigue aceptándose. Las fechas son opcionales
 * (permanentes, "por servicio"): sin fecha de fin no hay alertas.
 */
export class CreateContractDto {
  @IsString()
  @IsOptional()
  @MaxLength(50)
  contract_number?: string;

  /** I6: carpeta del control de contratos (A3T-0003). */
  @IsString()
  @IsOptional()
  @MaxLength(20)
  carpeta?: string;

  /** I6: tipo del documento dentro de la carpeta. */
  @IsIn(CONTRACT_DOC_KINDS)
  @IsOptional()
  doc_kind?: ContractDocKind;

  /** I6: número de la enmienda (sin él, la siguiente de la carpeta). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  doc_number?: number;

  /** I6: área usuaria responsable (catálogo de Compras). */
  @IsIn(CONTRACT_USER_AREAS)
  @IsOptional()
  user_area?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  tomo?: string;

  /** Tipo genérico; con `doc_kind` se deduce de él. */
  @IsIn(CONTRACT_DOCUMENT_TYPES)
  @IsOptional()
  document_type?: (typeof CONTRACT_DOCUMENT_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  service_description: string;

  @IsUUID()
  @IsNotEmpty()
  supplier_id: string;

  /** null o ausente = sin fecha (I6). */
  @IsDateString()
  @IsOptional()
  start_date?: string | null;

  /** null o ausente = "Sin fecha de fin": sin alertas de vencimiento (I6). */
  @IsDateString()
  @IsOptional()
  end_date?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  total_amount?: number;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  currency?: string;

  /** Consumido capturado por Compras (sprint 2026-09-22, B4). El saldo se calcula. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  consumed_amount?: number;

  /** Expediente en SharePoint (lo cargan ellos). */
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(2000)
  external_link?: string;

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

  /**
   * J2 (2026-10-01): vencido histórico = sin avisos de vencimiento. Por
   * defecto, el que se da de alta ya vencido; Compras lo desmarca si está en
   * renovación. Solo cuenta mientras el contrato esté vencido.
   */
  @IsBoolean()
  @IsOptional()
  vencido_historico?: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}
