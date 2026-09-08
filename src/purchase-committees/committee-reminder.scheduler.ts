import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PurchaseCommitteesService } from './purchase-committees.service';

/**
 * Fase §16 — Recordatorio diario al aprobador del turno vigente cuando el
 * comité lleva >48h sin acción (tabla de notificaciones de §16). 08:15 CDMX
 * para no empalmar con el job de contratos (08:00). Nunca revienta.
 */
@Injectable()
export class CommitteeReminderScheduler {
  private readonly logger = new Logger(CommitteeReminderScheduler.name);

  constructor(private readonly service: PurchaseCommitteesService) {}

  @Cron('15 8 * * *', { timeZone: 'America/Mexico_City' })
  async handleDailyReminder(): Promise<void> {
    try {
      await this.service.runReminderCheck();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Recordatorio de comités falló: ${msg}`);
    }
  }
}
