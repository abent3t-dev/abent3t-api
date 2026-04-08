import { IsString, IsOptional, IsUUID, IsDateString, IsIn } from 'class-validator';

export class FilterRequisitionDto {
  @IsString()
  @IsIn(['cancelada', 'cerrada', 'en_progreso', 'en_revision', 'en_aprobacion', 'aprobada'])
  @IsOptional()
  status?: string;

  @IsString()
  @IsIn(['CAPEX', 'OPEX'])
  @IsOptional()
  expense_type?: string;

  @IsUUID()
  @IsOptional()
  buyer_id?: string;

  @IsUUID()
  @IsOptional()
  requester_id?: string;

  @IsUUID()
  @IsOptional()
  department_id?: string;

  @IsString()
  @IsIn(['manual', 'maximo', 'sap'])
  @IsOptional()
  source?: string;

  @IsDateString()
  @IsOptional()
  date_from?: string;

  @IsDateString()
  @IsOptional()
  date_to?: string;
}
