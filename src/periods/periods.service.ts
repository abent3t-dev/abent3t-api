import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCrudPrismaService } from '../common/services/base-crud-prisma.service';
import { CreatePeriodDto } from './dto/create-period.dto';
import { UpdatePeriodDto } from './dto/update-period.dto';

@Injectable()
export class PeriodsService extends BaseCrudPrismaService<
  CreatePeriodDto,
  UpdatePeriodDto
> {
  protected get model() {
    return this.prisma.periods;
  }
  protected readonly orderField = 'year';
  protected readonly searchFields = ['label'];
  private readonly logger = new Logger(PeriodsService.name);

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  // Override: el orden histórico es year DESC, semester ASC (el más reciente
  // primero, luego semestres del mismo año en orden).
  async findAll() {
    return this.prisma.periods.findMany({
      orderBy: [{ year: 'desc' }, { semester: 'asc' }],
    });
  }

  async remove(id: string) {
    const count = await this.prisma.budgets.count({
      where: { period_id: id, is_active: true },
    });
    if (count > 0) {
      this.logger.warn(
        `Deactivating period ${id} which has ${count} active budgets — budgets NOT cascade-deactivated`,
      );
    }
    return super.remove(id);
  }
}
