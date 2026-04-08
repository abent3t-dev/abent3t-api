import { Module } from '@nestjs/common';
import { RequisitionsController } from './requisitions.controller';
import { RequisitionsService } from './requisitions.service';

@Module({
  controllers: [RequisitionsController],
  providers: [RequisitionsService],
  exports: [RequisitionsService],
})
export class RequisitionsModule {}
