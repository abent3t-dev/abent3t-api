import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MaximoRecordsController } from './maximo-records.controller';
import { MaximoRecordsService } from './maximo-records.service';

/**
 * Fase INT-5 — Módulo de dominio para LEER el staging de Maximo.
 * Sin escrituras y sin dependencia del código de la capa de integración
 * (regla 2 de la fase — verificado por grep en el cierre);
 * PrismaModule es global, solo se inyecta PrismaService.
 */
@Module({
  imports: [ConfigModule],
  controllers: [MaximoRecordsController],
  providers: [MaximoRecordsService],
})
export class MaximoRecordsModule {}
