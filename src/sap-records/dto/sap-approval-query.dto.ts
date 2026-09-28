import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Query de GET /sap/approval-requests (cola de autorización de SAP, B5).
 * Default `status=pending`: es la bandeja de lo que falta autorizar en SAP.
 */
export class SapApprovalQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Busca por remarks, solicitante, proveedor o número. */
  @IsOptional()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'all'])
  status?: 'pending' | 'approved' | 'rejected' | 'all';

  @IsOptional()
  @IsIn(['purchase_order', 'purchase_request'])
  kind?: 'purchase_order' | 'purchase_request';

  /**
   * G5 (2026-09-28): documentos de este aprobador (user_name de la cola de
   * SAP). Con `status=pending`, solo los que tiene en su etapa actual.
   */
  @IsOptional()
  @IsString()
  @MaxLength(150)
  approver?: string;
}
