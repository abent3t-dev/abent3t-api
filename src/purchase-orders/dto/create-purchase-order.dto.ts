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

export class CreatePurchaseOrderDto {
  @IsUUID()
  @IsNotEmpty()
  requisition_id: string;

  @IsUUID()
  @IsNotEmpty()
  supplier_id: string;

  @IsUUID()
  @IsOptional()
  contract_id?: string;

  @IsUUID()
  @IsOptional()
  purchase_type_id?: string;

  @IsNumber()
  @IsNotEmpty()
  @Min(0)
  amount: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsDateString()
  @IsNotEmpty()
  expected_delivery_date: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string;
}
