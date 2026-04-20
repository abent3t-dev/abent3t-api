import { Module } from '@nestjs/common';
import { TenenciaController } from './tenencia.controller';
import { TenenciaService } from './tenencia.service';

@Module({
  controllers: [TenenciaController],
  providers: [TenenciaService],
  exports: [TenenciaService],
})
export class TenenciaModule {}
