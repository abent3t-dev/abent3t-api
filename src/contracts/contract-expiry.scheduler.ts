import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ContractExpiryService } from './contract-expiry.service';

/**
 * Fase §15 — Cron diario 08:00 CDMX (timeZone explícito: el server puede
 * estar en UTC). El cron nunca revienta: cualquier error solo se loguea,
 * patrón de RemindersService.
 */
@Injectable()
export class ContractExpiryScheduler {
  private readonly logger = new Logger(ContractExpiryScheduler.name);

  constructor(private readonly expiryService: ContractExpiryService) {}

  @Cron('0 8 * * *', { timeZone: 'America/Mexico_City' })
  async handleDailyCheck(): Promise<void> {
    try {
      await this.expiryService.runCheck();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Job de alertas de contratos falló: ${msg}`);
    }
  }
}
