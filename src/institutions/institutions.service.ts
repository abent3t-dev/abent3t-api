import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCrudPrismaService } from '../common/services/base-crud-prisma.service';
import { CreateInstitutionDto } from './dto/create-institution.dto';
import { UpdateInstitutionDto } from './dto/update-institution.dto';

@Injectable()
export class InstitutionsService extends BaseCrudPrismaService<
  CreateInstitutionDto,
  UpdateInstitutionDto
> {
  protected get model() {
    return this.prisma.institutions;
  }
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name'];
  private readonly logger = new Logger(InstitutionsService.name);

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async remove(id: string) {
    const count = await this.prisma.courses.count({
      where: { institution_id: id, is_active: true },
    });
    if (count > 0) {
      this.logger.warn(
        `Deactivating institution ${id} which has ${count} active courses — courses NOT cascade-deactivated`,
      );
    }
    return super.remove(id);
  }
}
