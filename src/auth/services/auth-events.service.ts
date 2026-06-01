import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type AuthEventType =
  | 'login_success'
  | 'login_failed_password'
  | 'login_failed_user'
  | 'login_failed_inactive'
  | 'login_failed_locked'
  | 'login_failed_domain'
  | 'logout'
  | 'refresh'
  | 'password_set'
  | 'password_changed';

export interface AuthEventInput {
  event_type: AuthEventType;
  email?: string | null;
  profile_id?: string | null;
  success: boolean;
  reason?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * AuthEventsService — Bitácora de autenticación (PDF §8.3 / MIGRATION.md §3.4).
 * Adicional a `audit_logs` (que es bitácora de negocio). Ambos coexisten.
 *
 * Las inserciones son best-effort: nunca rompen el flujo de auth si falla.
 */
@Injectable()
export class AuthEventsService {
  private readonly logger = new Logger(AuthEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuthEventInput): Promise<void> {
    try {
      await this.prisma.auth_events.create({
        data: {
          event_type: input.event_type,
          email: input.email ?? null,
          profile_id: input.profile_id ?? null,
          success: input.success,
          reason: input.reason ?? null,
          ip_address: input.ip_address ?? null,
          user_agent: input.user_agent ?? null,
          metadata: (input.metadata ?? null) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // No bloquear el flujo de auth por un fallo de bitácora.
      this.logger.error('Failed to record auth_event', err);
    }
  }
}
