import { Module } from '@nestjs/common';
import { PurchaseTypesController } from './purchase-types.controller';
import { PurchaseTypesService } from './purchase-types.service';

@Module({
  controllers: [PurchaseTypesController],
  providers: [PurchaseTypesService],
  exports: [PurchaseTypesService],
})
export class PurchaseTypesModule {}
