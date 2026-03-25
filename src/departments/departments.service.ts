import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BaseCrudService } from '../common/services/base-crud.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

@Injectable()
export class DepartmentsService extends BaseCrudService<CreateDepartmentDto, UpdateDepartmentDto> {
  protected readonly tableName = 'departments';
  protected readonly selectFields = '*';
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name'];
  private readonly logger = new Logger(DepartmentsService.name);

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async remove(id: string) {
    const { count } = await this.supabase.db
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('department_id', id)
      .eq('is_active', true);

    if (count && count > 0) {
      this.logger.warn(
        `Deactivating department ${id} which has ${count} active profiles — profiles NOT cascade-deactivated`,
      );
    }
    return super.remove(id);
  }
}
