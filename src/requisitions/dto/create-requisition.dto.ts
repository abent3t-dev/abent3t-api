import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsOptional,
  IsNumber,
  IsDateString,
  IsIn,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateRequisitionDto {
  @IsString()
  @IsOptional()
  @MaxLength(50)
  rq_number?: string; // Se genera automaticamente si no se proporciona

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsUUID()
  @IsNotEmpty()
  requester_id: string;

  @IsUUID()
  @IsOptional()
  department_id?: string;

  @IsUUID()
  @IsOptional()
  buyer_id?: string;

  @IsString()
  @IsIn(['CAPEX', 'OPEX'])
  @IsOptional()
  expense_type?: string;

  @IsString()
  @IsIn(['manual', 'maximo', 'sap'])
  @IsOptional()
  source?: string;

  @IsString()
  @IsOptional()
  external_id?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  estimated_amount?: number;

  @IsString()
  @IsOptional()
  justification?: string;

  @IsDateString()
  @IsNotEmpty()
  created_date: string;

  @IsDateString()
  @IsOptional()
  required_date?: string;
}
