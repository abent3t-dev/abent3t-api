import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EmailModule } from '../email/email.module';
import { PurchaseCommitteesController } from './purchase-committees.controller';
import { PurchaseCommitteesService } from './purchase-committees.service';
import { CommitteeReminderScheduler } from './committee-reminder.scheduler';

/**
 * Fase §16 — Comité de Compras. Prisma/Storage/Audit son @Global;
 * EmailModule se importa explícito (precedente RemindersModule/§15).
 */
@Module({
  imports: [ScheduleModule.forRoot(), EmailModule],
  controllers: [PurchaseCommitteesController],
  providers: [PurchaseCommitteesService, CommitteeReminderScheduler],
  exports: [PurchaseCommitteesService],
})
export class PurchaseCommitteesModule {}
