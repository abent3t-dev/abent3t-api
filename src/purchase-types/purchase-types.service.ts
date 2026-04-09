import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BaseCrudService } from '../common/services/base-crud.service';
import { CreatePurchaseTypeDto } from './dto/create-purchase-type.dto';
import { UpdatePurchaseTypeDto } from './dto/update-purchase-type.dto';

@Injectable()
export class PurchaseTypesService extends BaseCrudService<CreatePurchaseTypeDto, UpdatePurchaseTypeDto> {
  protected readonly tableName = 'purchase_types';
  protected readonly selectFields = '*';
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name', 'key'];

  constructor(supabase: SupabaseService) {
    super(supabase);
  }
}
