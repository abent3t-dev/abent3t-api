import { IsIn, IsOptional } from 'class-validator';

/** Body de POST /integrations/sap/sync. */
export class TriggerSapSyncDto {
  @IsOptional()
  @IsIn(['purchase_orders', 'purchase_requests', 'all'])
  target?: 'purchase_orders' | 'purchase_requests' | 'all';

  /**
   * full = barrido completo; incremental = desde el último UpdateDate visto.
   * Omitido → incremental si el staging ya tiene datos, full si está vacío.
   */
  @IsOptional()
  @IsIn(['full', 'incremental'])
  mode?: 'full' | 'incremental';
}
