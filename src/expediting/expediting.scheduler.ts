import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ExpeditingService } from './expediting.service';

/**
 * Fase Expeditación — Job diario de alertas (-15 / vencida / +7, T9).
 * 08:30 CDMX para escalonar con contratos (08:00) y comité (08:15).
 */
@Injectable()
export class ExpeditingScheduler {
  private readonly logger = new Logger(ExpeditingScheduler.name);

  constructor(private readonly service: ExpeditingService) {}

  @Cron('30 8 * * *', { timeZone: 'America/Mexico_City' })
  async handleDailyCheck(): Promise<void> {
    try {
      await this.service.runAlertCheck();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Job de alertas de expeditación falló: ${msg}`);
    }
  }
}
