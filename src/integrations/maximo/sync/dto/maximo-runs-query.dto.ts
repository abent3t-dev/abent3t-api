import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Query de GET /integrations/maximo/runs (mismo shape que PaginationDto). */
export class MaximoRunsQueryDto {
  @IsOptional()
  @IsIn(['purchase_orders', 'contracts'])
  target?: 'purchase_orders' | 'contracts';

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
