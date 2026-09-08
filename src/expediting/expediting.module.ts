import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EmailModule } from '../email/email.module';
import { ExpeditingController } from './expediting.controller';
import { ExpeditingService } from './expediting.service';
import { ExpeditingScheduler } from './expediting.scheduler';

/**
 * Fase Expeditación — seguimiento de entregas + alertas -15/vencida/+7.
 * Prisma es @Global; EmailModule explícito (precedente §15/§16). Sin
 * AuditService (solo el comité audita) y sin sockets (pendiente global).
 */
@Module({
  imports: [ScheduleModule.forRoot(), EmailModule],
  controllers: [ExpeditingController],
  providers: [ExpeditingService, ExpeditingScheduler],
  exports: [ExpeditingService],
})
export class ExpeditingModule {}
