import { IsNumber, IsBoolean, IsOptional, Min } from 'class-validator';

export class UpdateBudgetDto {
  @IsNumber()
  @Min(0)
  @IsOptional()
  assigned_amount?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  consumed_amount?: number;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
