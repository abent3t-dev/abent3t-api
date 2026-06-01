import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCrudPrismaService } from '../common/services/base-crud-prisma.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

@Injectable()
export class DepartmentsService extends BaseCrudPrismaService<
  CreateDepartmentDto,
  UpdateDepartmentDto
> {
  protected get model() {
    return this.prisma.departments;
  }
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name'];
  private readonly logger = new Logger(DepartmentsService.name);

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async remove(id: string) {
    const count = await this.prisma.profiles.count({
      where: { department_id: id, is_active: true },
    });
    if (count > 0) {
      this.logger.warn(
        `Deactivating department ${id} which has ${count} active profiles — profiles NOT cascade-deactivated`,
      );
    }
    return super.remove(id);
  }
}
