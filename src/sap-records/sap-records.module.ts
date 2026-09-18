import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SapRecordsController } from './sap-records.controller';
import { SapRecordsService } from './sap-records.service';

/**
 * SapRecordsModule — Fase INT-4: lectura de dominio del staging de SAP.
 * Depende SOLO de Prisma (global) y ConfigService; nada de la capa externa.
 */
@Module({
  imports: [ConfigModule],
  controllers: [SapRecordsController],
  providers: [SapRecordsService],
  exports: [SapRecordsService],
})
export class SapRecordsModule {}
