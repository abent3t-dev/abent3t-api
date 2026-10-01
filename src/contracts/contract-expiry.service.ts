import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import type { ContractDigestItem } from '../email/email.interfaces';
import { cdmxDateUtc, daysUntil } from './contracts.dates';

/**
 * Fase §15 — Alertas de vencimiento de contratos. El cron diario vive en
 * ContractExpiryScheduler; aquí está la lógica con el reloj INYECTABLE
 * (`runCheck(now)`) para poder probarla con fechas fijas y ejecutarla a mano
 * (`npm run contracts:check-expiry`).
 *
 * Bloque 2026-09-23 (D11, requisitos de César 2026-09-22): la alerta arranca
 * `CONTRACT_ALERT_DAYS_BEFORE` días antes (default 45) y sigue TODOS LOS
 * DÍAS hasta que el contrato deje de estar vigente/vencido (renovado o
 * cancelado). Un contrato que llega al día 0 pasa a `vencido` y sigue
 * alertando (como vencido) hasta la renovación o el cierre. Destinatarios:
 * comprador del contrato, usuario responsable y los administradores de
 * contratos (lider_procura). El área usuaria no tiene correo.
 *
 * J2 (hilo con César, 2026-10-01): con la base real, un correo por contrato
 * y por día eran más de 118 correos diarios para Ingrid. Ahora:
 *  - UN resumen diario por persona con todos sus contratos ("por vencer en N
 *    días" y "vencidos sin renovar");
 *  - los vencidos históricos (`vencido_historico`: ya vencidos al cargar la
 *    base real o al darse de alta) no alertan. Compras los desmarca a mano si
 *    alguno sí está en renovación; los que venzan de aquí en adelante siguen
 *    la regla de 45 días.
 *
 * Idempotencia por DÍA: una fila de `contract_expiry_notifications` por
 * contrato incluido en el resumen (UNIQUE contract_id + tipo + destinatario,
 * tipo `expiring:YYYY-MM-DD` / `expired:YYYY-MM-DD`). El registro y el envío
 * del resumen van en la misma transacción: un envío fallido revierte las
 * filas y se reintenta en la siguiente corrida; si ya estaban todas, el
 * resumen de hoy ya salió.
 */

export const DEFAULT_ALERT_DAYS_BEFORE = 45;

export interface ContractExpiryCheckResult {
  checkedContracts: number;
  /** J2: contratos que entran a los resúmenes de hoy. */
  alertingContracts: number;
  /** J2: resúmenes enviados (uno por persona). */
  digestsSent: number;
  /** Personas que ya tenían su resumen de hoy. */
  alreadyNotified: number;
  expiredMarked: number;
  /** J2: vencidos históricos que no alertan. */
  historicSkipped: number;
  errors: string[];
}

interface Recipient {
  email: string;
  name: string | null;
  role: string;
}

interface DigestEntry extends ContractDigestItem {
  contractId: string;
  notificationType: string;
  role: string;
}

/** Ya estaban todas las filas: el resumen de hoy ya salió. */
class AlreadyNotifiedToday extends Error {}

const MAX_ERRORS = 20;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

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
      alertingContracts: 0,
      digestsSent: 0,
      alreadyNotified: 0,
      expiredMarked: 0,
      historicSkipped: 0,
      errors: [],
    };
    const today = cdmxDateUtc(now);
    const todayKey = isoDay(today);
    const threshold = this.alertDaysBefore;

    // Vigentes (por vencer) y vencidos (siguen alertando a diario hasta que
    // Compras los renueve o cierre). Renovado/cancelado quedan fuera. I6: sin
    // fecha de fin (permanentes, "por servicio") no hay vencimiento.
    const contracts = await this.prisma.contracts.findMany({
      where: {
        status: { in: ['vigente', 'vencido'] },
        is_active: true,
        end_date: { not: null },
      },
      include: {
        suppliers: { select: { legal_name: true } },
        profiles_contracts_buyer_profile_idToprofiles: {
          select: { email: true, full_name: true },
        },
      },
      orderBy: [{ end_date: 'asc' }, { contract_number: 'asc' }],
    });
    result.checkedContracts = contracts.length;
    const admins = await this.contractAdmins();

    // Un resumen por persona con todos sus contratos
    const digests = new Map<
      string,
      { recipient: Recipient; entries: DigestEntry[] }
    >();
    for (const contract of contracts) {
      const endDate = contract.end_date;
      if (!endDate) continue;
      const daysLeft = daysUntil(endDate, today);
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
      // J2: los vencidos históricos no alertan
      if (expired && contract.vencido_historico) {
        result.historicSkipped += 1;
        continue;
      }
      result.alertingContracts += 1;

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
      for (const c of candidates) {
        const email = c.email?.trim().toLowerCase();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        const digest = digests.get(email) ?? {
          recipient: { email, name: c.name ?? null, role: c.role },
          entries: [],
        };
        digest.entries.push({
          contractId: contract.id,
          contractNumber: contract.contract_number,
          supplierName: contract.suppliers.legal_name,
          serviceDescription: contract.service_description,
          endDate: isoDay(endDate),
          daysLeft,
          notificationType: `${expired ? 'expired' : 'expiring'}:${todayKey}`,
          role: c.role,
        });
        digests.set(email, digest);
      }
    }

    for (const { recipient, entries } of digests.values()) {
      try {
        await this.sendDigest(recipient, entries, threshold);
        result.digestsSent += 1;
      } catch (err: unknown) {
        if (err instanceof AlreadyNotifiedToday) {
          result.alreadyNotified += 1;
          continue;
        }
        // Un destinatario fallido no detiene el job
        if (result.errors.length < MAX_ERRORS) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${recipient.email}: ${msg}`);
        }
      }
    }

    this.logger.log(
      `Avisos de contratos (umbral ${threshold} días, resumen diario): revisados=${result.checkedContracts} ` +
        `en el resumen=${result.alertingContracts} resúmenes=${result.digestsSent} repetidos=${result.alreadyNotified} ` +
        `vencidos=${result.expiredMarked} históricos=${result.historicSkipped} errores=${result.errors.length}`,
    );
    return result;
  }

  /** Registro por contrato + el resumen de la persona, en una transacción. */
  private async sendDigest(
    recipient: Recipient,
    entries: DigestEntry[],
    threshold: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.contract_expiry_notifications.createMany({
        data: entries.map((e) => ({
          contract_id: e.contractId,
          notification_type: e.notificationType,
          recipient_email: recipient.email,
          recipient_role: e.role,
        })),
        skipDuplicates: true,
      });
      if (count === 0) throw new AlreadyNotifiedToday();

      const item = (e: DigestEntry): ContractDigestItem => ({
        contractNumber: e.contractNumber,
        supplierName: e.supplierName,
        serviceDescription: e.serviceDescription,
        endDate: e.endDate,
        daysLeft: e.daysLeft,
      });
      const rendered = this.emailService.renderTemplate('contract_digest', {
        recipientName: recipient.name ?? recipient.email,
        porVencer: entries
          .filter((e) => e.daysLeft > 0)
          .sort((a, b) => a.daysLeft - b.daysLeft)
          .map(item),
        vencidos: entries
          .filter((e) => e.daysLeft <= 0)
          .sort((a, b) => a.daysLeft - b.daysLeft)
          .map(item),
        thresholdDays: threshold,
      });
      const sent = await this.emailService.sendEmail({
        to: { email: recipient.email, name: recipient.name ?? undefined },
        subject: rendered.subject,
        body: rendered.body,
        isHtml: true,
      });
      // Envío fallido → rollback del registro para reintentar mañana
      if (!sent.success) {
        throw new Error(sent.error ?? 'envío de correo fallido');
      }
    });
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
