import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';
import { SupplierSapMirrorService } from './supplier-sap-mirror.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [SuppliersController],
  providers: [SuppliersService, SupplierSapMirrorService],
  exports: [SuppliersService, SupplierSapMirrorService],
})
export class SuppliersModule {}
