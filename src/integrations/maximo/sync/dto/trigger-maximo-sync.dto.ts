import { IsIn, IsOptional } from 'class-validator';

/** Body de POST /integrations/maximo/sync. O2: 'rfqs' (AB_COTIZACIONES). */
export class TriggerMaximoSyncDto {
  @IsOptional()
  @IsIn(['purchase_orders', 'contracts', 'rfqs', 'all'])
  target?: 'purchase_orders' | 'contracts' | 'rfqs' | 'all';
}
