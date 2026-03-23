import { IsUUID, IsNumber, IsNotEmpty, Min } from 'class-validator';

export class CreateBudgetDto {
  @IsUUID()
  @IsNotEmpty()
  department_id: string;

  @IsUUID()
  @IsNotEmpty()
  period_id: string;

  @IsNumber()
  @Min(0)
  assigned_amount: number;
}
