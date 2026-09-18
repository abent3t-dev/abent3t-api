import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Query de GET /integrations/sap/runs (mismo shape que PaginationDto). */
export class SapRunsQueryDto {
  @IsOptional()
  @IsIn(['purchase_orders', 'purchase_requests', 'business_partners'])
  target?: 'purchase_orders' | 'purchase_requests' | 'business_partners';

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
}
