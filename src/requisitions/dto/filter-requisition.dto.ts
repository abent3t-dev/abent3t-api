import {
  IsString,
  IsOptional,
  IsUUID,
  IsDateString,
  IsIn,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { toStatusList } from '../../sap-records/dto/sap-doc-query.dto';

export const REQUISITION_STATUSES = [
  'cancelada',
  'cerrada',
  'en_progreso',
  'en_revision',
  'en_aprobacion',
  'aprobada',
] as const;

export class FilterRequisitionDto {
  /** Uno o varios estatus separados por coma (A5: multi-selección). */
  @Transform(({ value }) => toStatusList(value))
  @IsIn(REQUISITION_STATUSES, { each: true })
  @IsOptional()
  status?: string[];

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
