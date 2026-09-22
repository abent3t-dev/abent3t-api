import { IsIn, IsInt, IsOptional, Max, MaxLength, Min } from 'class-validator';
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
}
