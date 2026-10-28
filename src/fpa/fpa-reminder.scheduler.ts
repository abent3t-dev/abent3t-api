import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FpaFlowService } from './fpa-flow.service';

/**
 * FP&A (B3) — recordatorio diario a quien tiene un turno de firma que lleva
 * más de 2 días hábiles (diseño §4). 08:25 CDMX, después de contratos (08:00)
 * y del comité (08:15). Solo en días hábiles. Nunca revienta.
 *
 * FpaModule no importa ScheduleModule.forRoot(): el cron lo registran los
 * forRoot() que ya importan otros módulos, y cada uno lo registra otra vez
 * (con Nest 11, cada import es un módulo distinto). Mientras la plataforma
 * tenga varios, el cron se dispara varias veces a la misma hora: el candado
 * deja correr solo la primera (el correo, además, no se duplica por la llave
 * de la cola).
 */
@Injectable()
export class FpaReminderScheduler {
  private readonly logger = new Logger(FpaReminderScheduler.name);
  private running = false;

  constructor(private readonly flow: FpaFlowService) {}

  @Cron('25 8 * * *', { timeZone: 'America/Mexico_City' })
  async handleDailyReminder(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.flow.runReminderCheck();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Recordatorio de FP&A falló: ${msg}`);
    } finally {
      this.running = false;
    }
  }
}
