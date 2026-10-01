import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EmailOutboxService } from './email-outbox.service';

/** Cada cuánto se revisa la cola; el ritmo real lo pone EMAIL_MIN_INTERVAL_SECONDS. */
export const EMAIL_WORKER_TICK_MS = 15_000;

/**
 * J1 — Worker de la cola de correo: el ÚNICO que envía. Cada tick intenta
 * sacar un correo (respetando pausa, tope y ritmo); nunca dos ticks a la vez.
 */
@Injectable()
export class EmailOutboxWorker implements OnModuleInit {
  private readonly logger = new Logger('Email:worker');
  private busy = false;

  constructor(private readonly outbox: EmailOutboxService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.outbox.releaseStuck();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`No se pudo liberar la cola al arrancar: ${msg}`);
    }
  }

  @Interval('email-outbox', EMAIL_WORKER_TICK_MS)
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.outbox.processNext();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Worker de correo falló: ${msg}`);
    } finally {
      this.busy = false;
    }
  }
}
