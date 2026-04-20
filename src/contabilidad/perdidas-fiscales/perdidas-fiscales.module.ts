import { Module } from '@nestjs/common';
import { PerdidasFiscalesController } from './perdidas-fiscales.controller';
import { PerdidasFiscalesService } from './perdidas-fiscales.service';

@Module({
  controllers: [PerdidasFiscalesController],
  providers: [PerdidasFiscalesService],
  exports: [PerdidasFiscalesService],
})
export class PerdidasFiscalesModule {}
