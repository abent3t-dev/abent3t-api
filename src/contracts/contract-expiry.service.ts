import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { cdmxDateUtc, daysUntil } from './contracts.dates';

/**
 * Fase §15 — Alertas de vencimiento 30/7/0 (unificadas). El cron diario vive
 * en ContractExpiryScheduler; aquí está la lógica con el reloj INYECTABLE
 * (`runCheck(now)`) para poder probarla con fechas fijas y ejecutarla a mano
 * (`npm run contracts:check-expiry`).
 *
 * Idempotencia: UNIQUE (contract_id, notification_type, recipient_email) —
 * el insert del log y el envío del correo van en la misma transacción, así
 * un envío fallido revierte el log y se reintenta al día siguiente; un P2002
 * significa "ya enviado hoy o antes" y se ignora.
 */

export type ExpiryNotificationType =
  | '30_days_before'
  | '7_days_before'
  | 'expired';

export interface ContractExpiryCheckResult {
  checkedContracts: number;
  notificationsSent: number;
  alreadyNotified: number;
  expiredMarked: number;
  errors: string[];
}

const MAX_ERRORS = 20;

@Injectable()
export class ContractExpiryService {
  private readonly logger = new Logger(ContractExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async runCheck(now: Date = new Date()): Promise<ContractExpiryCheckResult> {
    const result: ContractExpiryCheckResult = {
      checkedContracts: 0,
      notificationsSent: 0,
      alreadyNotified: 0,
      expiredMarked: 0,
      errors: [],
    };
    const today = cdmxDateUtc(now);

    // Solo vigentes: un contrato ya `vencido` no re-alerta (y renovado/
    // cancelado quedan fuera por definición).
    const contracts = await this.prisma.contracts.findMany({
      where: { status: 'vigente', is_active: true },
      include: {
        suppliers: { select: { legal_name: true } },
        profiles_contracts_buyer_profile_idToprofiles: {
          select: { email: true, full_name: true },
        },
      },
    });
    result.checkedContracts = contracts.length;

    for (const contract of contracts) {
      const daysLeft = daysUntil(contract.end_date, today);
      // <= 0 (no === 0): si el job no corrió justo el día 0 (server caído),
      // el contrato igual pasa a vencido en la siguiente corrida.
      const type: ExpiryNotificationType | null =
        daysLeft === 30
          ? '30_days_before'
          : daysLeft === 7
            ? '7_days_before'
            : daysLeft <= 0
              ? 'expired'
              : null;
      if (!type) continue;

      if (type === 'expired') {
        await this.prisma.contracts.update({
          where: { id: contract.id },
          data: { status: 'vencido' },
        });
        result.expiredMarked += 1;
      }

      const buyer = contract.profiles_contracts_buyer_profile_idToprofiles;
      const recipients = [
        { email: buyer?.email, name: buyer?.full_name, role: 'comprador' },
        {
          email: contract.responsible_user_email,
          name: contract.responsible_user_name,
          role: 'responsible_user',
        },
      ].filter((r): r is { email: string; name: string | null; role: string } =>
        Boolean(r.email),
      );

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
              type === 'expired' ? 'contract_expired' : 'contract_expiring',
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
      `Alertas de contratos: revisados=${result.checkedContracts} enviadas=${result.notificationsSent} ` +
        `repetidas=${result.alreadyNotified} vencidos=${result.expiredMarked} errores=${result.errors.length}`,
    );
    return result;
  }
}
