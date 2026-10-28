import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FpaFlowService } from './fpa-flow.service';

/**
 * FP&A (B3) — recordatorio diario a quien tiene un turno de firma que lleva
 * más de 2 días hábiles (diseño §4). 08:25 CDMX, después de contratos (08:00)
 * y del comité (08:15). Solo en días hábiles. Nunca revienta.
 */
@Injectable()
export class FpaReminderScheduler {
  private readonly logger = new Logger(FpaReminderScheduler.name);

  constructor(private readonly flow: FpaFlowService) {}

  @Cron('25 8 * * *', { timeZone: 'America/Mexico_City' })
  async handleDailyReminder(): Promise<void> {
    try {
      await this.flow.runReminderCheck();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Recordatorio de FP&A falló: ${msg}`);
    }
  }
}
