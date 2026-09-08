import { IsIn, IsOptional } from 'class-validator';

/** Body de POST /integrations/maximo/sync. */
export class TriggerMaximoSyncDto {
  @IsOptional()
  @IsIn(['purchase_orders', 'contracts', 'all'])
  target?: 'purchase_orders' | 'contracts' | 'all';
}
