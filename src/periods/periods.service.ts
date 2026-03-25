import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BaseCrudService } from '../common/services/base-crud.service';
import { CreatePeriodDto } from './dto/create-period.dto';
import { UpdatePeriodDto } from './dto/update-period.dto';

@Injectable()
export class PeriodsService extends BaseCrudService<CreatePeriodDto, UpdatePeriodDto> {
  protected readonly tableName = 'periods';
  protected readonly selectFields = '*';
  protected readonly orderField = 'year';
  protected readonly searchFields = ['label'];
  private readonly logger = new Logger(PeriodsService.name);

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async findAll() {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .order('year', { ascending: false })
      .order('semester', { ascending: true });

    if (error) throw error;
    return data;
  }

  async remove(id: string) {
    const { count } = await this.supabase.db
      .from('budgets')
      .select('id', { count: 'exact', head: true })
      .eq('period_id', id)
      .eq('is_active', true);

    if (count && count > 0) {
      this.logger.warn(
        `Deactivating period ${id} which has ${count} active budgets — budgets NOT cascade-deactivated`,
      );
    }
    return super.remove(id);
  }
}
