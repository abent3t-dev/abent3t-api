import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EmailService } from './email.service';
import { EmailTransportService } from './email-transport.service';
import { EmailOutboxService } from './email-outbox.service';
import { EmailOutboxWorker } from './email-outbox.worker';
import { EmailOutboxController } from './email-outbox.controller';

/**
 * Correo de la plataforma. J1 (2026-10-01): todo pasa por la cola
 * (EmailOutboxService); el único que envía es el worker. ScheduleModule es
 * idempotente (contratos y expeditación también lo importan).
 */
@Global()
@Module({
  imports: [ConfigModule, ScheduleModule.forRoot()],
  controllers: [EmailOutboxController],
  providers: [
    EmailService,
    EmailTransportService,
    EmailOutboxService,
    EmailOutboxWorker,
  ],
  exports: [EmailService, EmailOutboxService, EmailTransportService],
})
export class EmailModule {}
