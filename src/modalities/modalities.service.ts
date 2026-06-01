import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCrudPrismaService } from '../common/services/base-crud-prisma.service';
import { CreateModalityDto } from './dto/create-modality.dto';
import { UpdateModalityDto } from './dto/update-modality.dto';

@Injectable()
export class ModalitiesService extends BaseCrudPrismaService<
  CreateModalityDto,
  UpdateModalityDto
> {
  protected get model() {
    return this.prisma.modalities;
  }
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name', 'key'];

  constructor(prisma: PrismaService) {
    super(prisma);
  }
}
