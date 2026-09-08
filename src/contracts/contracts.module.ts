import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EmailModule } from '../email/email.module';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ContractExpiryScheduler } from './contract-expiry.scheduler';
import { ContractExpiryService } from './contract-expiry.service';

/**
 * Fase §15 — Gestión de Contratos (repositorio documental + alertas 30/7/0).
 * PrismaModule y StorageModule son @Global (no se importan); EmailModule
 * también lo es, pero se importa explícito siguiendo el precedente de
 * RemindersModule. ScheduleModule.forRoot() es idempotente en Nest.
 */
@Module({
  imports: [ScheduleModule.forRoot(), EmailModule],
  controllers: [ContractsController],
  providers: [ContractsService, ContractExpiryService, ContractExpiryScheduler],
  exports: [ContractExpiryService],
})
export class ContractsModule {}
