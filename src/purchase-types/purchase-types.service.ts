import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCrudPrismaService } from '../common/services/base-crud-prisma.service';
import { CreatePurchaseTypeDto } from './dto/create-purchase-type.dto';
import { UpdatePurchaseTypeDto } from './dto/update-purchase-type.dto';

@Injectable()
export class PurchaseTypesService extends BaseCrudPrismaService<
  CreatePurchaseTypeDto,
  UpdatePurchaseTypeDto
> {
  protected get model() {
    return this.prisma.purchase_types;
  }
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name', 'key'];

  constructor(prisma: PrismaService) {
    super(prisma);
  }
}
