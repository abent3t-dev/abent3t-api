import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BaseCrudService } from '../common/services/base-crud.service';
import { CreateInstitutionDto } from './dto/create-institution.dto';
import { UpdateInstitutionDto } from './dto/update-institution.dto';

@Injectable()
export class InstitutionsService extends BaseCrudService<CreateInstitutionDto, UpdateInstitutionDto> {
  protected readonly tableName = 'institutions';
  protected readonly selectFields = '*';
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name'];
  private readonly logger = new Logger(InstitutionsService.name);

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async remove(id: string) {
    const { count } = await this.supabase.db
      .from('courses')
      .select('id', { count: 'exact', head: true })
      .eq('institution_id', id)
      .eq('is_active', true);

    if (count && count > 0) {
      this.logger.warn(
        `Deactivating institution ${id} which has ${count} active courses — courses NOT cascade-deactivated`,
      );
    }
    return super.remove(id);
  }
}
