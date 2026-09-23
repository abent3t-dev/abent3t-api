import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { cdmxDateUtc, daysUntil } from './contracts.dates';

/**
 * Fase §15 — Alertas de vencimiento de contratos. El cron diario vive en
 * ContractExpiryScheduler; aquí está la lógica con el reloj INYECTABLE
 * (`runCheck(now)`) para poder probarla con fechas fijas y ejecutarla a mano
 * (`npm run contracts:check-expiry`).
 *
 * Bloque 2026-09-23 (D11, requisitos de César 2026-09-22): en lugar de los
 * hitos 30/7/0, la alerta arranca `CONTRACT_ALERT_DAYS_BEFORE` días antes
 * (default 45) y se manda TODOS LOS DÍAS hasta que el contrato deje de estar
 * vigente/vencido (renovado o cancelado). Un contrato que llega al día 0
 * pasa a `vencido` y sigue alertando (como vencido) hasta la renovación o el
 * cierre. Destinatarios: comprador del contrato, usuario responsable
 * ("Adm. de contrato") y los administradores de contratos (lider_procura).
 *
 * Idempotencia por DÍA: UNIQUE (contract_id, notification_type,
 * recipient_email) con `notification_type = expiring:YYYY-MM-DD` /
 * `expired:YYYY-MM-DD` — el insert del log y el envío del correo van en la
 * misma transacción, así un envío fallido revierte el log y se reintenta en
 * la siguiente corrida; un P2002 significa "ya enviado hoy" y se ignora.
 */

export const DEFAULT_ALERT_DAYS_BEFORE = 45;

export interface ContractExpiryCheckResult {
  checkedContracts: number;
  notificationsSent: number;
  alreadyNotified: number;
  expiredMarked: number;
  errors: string[];
}

interface Recipient {
  email: string;
  name: string | null;
  role: string;
}

const MAX_ERRORS = 20;

@Injectable()
export class ContractExpiryService {
  private readonly logger = new Logger(ContractExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService,
  ) {}

  /** Días antes del vencimiento desde los que se alerta (env, default 45). */
  get alertDaysBefore(): number {
    const raw = this.config.get<number | string>('CONTRACT_ALERT_DAYS_BEFORE');
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : DEFAULT_ALERT_DAYS_BEFORE;
  }

  async runCheck(now: Date = new Date()): Promise<ContractExpiryCheckResult> {
    const result: ContractExpiryCheckResult = {
      checkedContracts: 0,
      notificationsSent: 0,
      alreadyNotified: 0,
      expiredMarked: 0,
      errors: [],
    };
    const today = cdmxDateUtc(now);
    const todayKey = today.toISOString().slice(0, 10);
    const threshold = this.alertDaysBefore;

    // Vigentes (por vencer) y vencidos (siguen alertando a diario hasta que
    // Compras los renueve o cierre). Renovado/cancelado quedan fuera.
    const contracts = await this.prisma.contracts.findMany({
      where: { status: { in: ['vigente', 'vencido'] }, is_active: true },
      include: {
        suppliers: { select: { legal_name: true } },
        profiles_contracts_buyer_profile_idToprofiles: {
          select: { email: true, full_name: true },
        },
      },
    });
    result.checkedContracts = contracts.length;
    const admins = await this.contractAdmins();

    for (const contract of contracts) {
      const daysLeft = daysUntil(contract.end_date, today);
      if (contract.status === 'vigente' && daysLeft > threshold) continue;

      // <= 0 (no === 0): si el job no corrió justo el día 0 (server caído),
      // el contrato igual pasa a vencido en la siguiente corrida.
      const expired = daysLeft <= 0;
      if (expired && contract.status === 'vigente') {
        await this.prisma.contracts.update({
          where: { id: contract.id },
          data: { status: 'vencido' },
        });
        result.expiredMarked += 1;
      }
      const type = `${expired ? 'expired' : 'expiring'}:${todayKey}`;

      const buyer = contract.profiles_contracts_buyer_profile_idToprofiles;
      const candidates: Array<{
        email: string | null | undefined;
        name: string | null | undefined;
        role: string;
      }> = [
        { email: buyer?.email, name: buyer?.full_name, role: 'comprador' },
        {
          email: contract.responsible_user_email,
          name: contract.responsible_user_name,
          role: 'responsible_user',
        },
        ...admins.map((a) => ({
          email: a.email,
          name: a.full_name,
          role: 'contract_admin',
        })),
      ];
      const seen = new Set<string>();
      const recipients: Recipient[] = [];
      for (const c of candidates) {
        const email = c.email?.trim().toLowerCase();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        recipients.push({ email, name: c.name ?? null, role: c.role });
      }

      for (const recipient of recipients) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await tx.contract_expiry_notifications.create({
              data: {
                contract_id: contract.id,
                notification_type: type,
                recipient_email: recipient.email,
                recipient_role: recipient.role,
              },
            });
            const rendered = this.emailService.renderTemplate(
              expired ? 'contract_expired' : 'contract_expiring',
              {
                recipientName: recipient.name ?? recipient.email,
                contractNumber: contract.contract_number,
                serviceDescription: contract.service_description,
                supplierName: contract.suppliers.legal_name,
                endDate: contract.end_date.toISOString().slice(0, 10),
                totalAmount:
                  contract.total_amount === null
                    ? null
                    : Number(contract.total_amount),
                currency: contract.currency,
                buyerName: buyer?.full_name ?? null,
                responsibleName: contract.responsible_user_name,
                daysLeft,
              },
            );
            const sent = await this.emailService.sendEmail({
              to: { email: recipient.email, name: recipient.name ?? undefined },
              subject: rendered.subject,
              body: rendered.body,
              isHtml: true,
            });
            // Envío fallido → rollback del log para reintentar mañana
            if (!sent.success) {
              throw new Error(sent.error ?? 'envío de correo fallido');
            }
          });
          result.notificationsSent += 1;
        } catch (err: unknown) {
          // Duck-typing del código Prisma (patrón del repo, ver staging Int-3)
          if ((err as { code?: string }).code === 'P2002') {
            result.alreadyNotified += 1;
            continue;
          }
          // Un destinatario fallido no detiene ni el contrato ni el job
          if (result.errors.length < MAX_ERRORS) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(
              `${contract.contract_number}/${recipient.email}: ${msg}`,
            );
          }
        }
      }
    }

    this.logger.log(
      `Alertas de contratos (umbral ${threshold} días, diaria): revisados=${result.checkedContracts} enviadas=${result.notificationsSent} ` +
        `repetidas=${result.alreadyNotified} vencidos=${result.expiredMarked} errores=${result.errors.length}`,
    );
    return result;
  }

  /** Administradores de contratos: perfiles activos con rol lider_procura. */
  private async contractAdmins(): Promise<
    Array<{ email: string; full_name: string | null }>
  > {
    return this.prisma.profiles.findMany({
      where: {
        is_active: true,
        OR: [
          {
            user_roles_user_roles_profile_idToprofiles: {
              some: { is_active: true, role: 'lider_procura' },
            },
          },
          { role: 'lider_procura' },
        ],
      },
      select: { email: true, full_name: true },
    });
  }
}
