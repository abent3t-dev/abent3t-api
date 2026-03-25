import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BaseCrudService } from '../common/services/base-crud.service';
import { CreateModalityDto } from './dto/create-modality.dto';
import { UpdateModalityDto } from './dto/update-modality.dto';

@Injectable()
export class ModalitiesService extends BaseCrudService<CreateModalityDto, UpdateModalityDto> {
  protected readonly tableName = 'modalities';
  protected readonly selectFields = '*';
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name', 'key'];

  constructor(supabase: SupabaseService) {
    super(supabase);
  }
}
