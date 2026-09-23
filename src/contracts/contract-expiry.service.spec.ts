import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { ContractExpiryService } from './contract-expiry.service';
import { cdmxDateUtc, daysUntil } from './contracts.dates';

/**
 * Fase §15 / bloque 2026-09-23 (D11). Job de alertas probado con reloj
 * INYECTADO y Prisma simulado en memoria — cero red, cero BD, cero correos
 * reales. Regla nueva: alerta desde CONTRACT_ALERT_DAYS_BEFORE (45) días
 * antes, DIARIA hasta que el contrato se renueve o cierre; al día 0 pasa a
 * vencido y sigue alertando como vencido.
 */

/** 2026-09-01 12:00 UTC = 06:00 CDMX del mismo día. */
const NOW = new Date('2026-09-01T12:00:00Z');
const TOMORROW = new Date('2026-09-02T12:00:00Z');
const TODAY = cdmxDateUtc(NOW); // 2026-09-01 UTC-midnight

const dayAt = (daysFromToday: number) =>
  new Date(TODAY.getTime() + daysFromToday * 86_400_000);

interface NotifRow {
  contract_id: string;
  notification_type: string;
  recipient_email: string;
  recipient_role: string | null;
}

function makeHarness(
  contracts: Array<Record<string, unknown>>,
  options: {
    admins?: Array<{ email: string; full_name: string | null }>;
    daysBefore?: string;
  } = {},
) {
  const notifications: NotifRow[] = [];
  const emailsSent: Array<{ to: string; template: string }> = [];
  let failEmails = false;

  const notifTable = {
    create: jest.fn(({ data }: { data: NotifRow }) => {
      const duplicate = notifications.some(
        (n) =>
          n.contract_id === data.contract_id &&
          n.notification_type === data.notification_type &&
          n.recipient_email === data.recipient_email,
      );
      if (duplicate) {
        return Promise.reject(
          Object.assign(new Error('Unique constraint'), { code: 'P2002' }),
        );
      }
      notifications.push({ ...data });
      return Promise.resolve({ id: 'n', ...data });
    }),
  };

  const prisma = {
    contracts: {
      findMany: jest.fn(() =>
        Promise.resolve(
          contracts.filter(
            (c) =>
              (c.status === 'vigente' || c.status === 'vencido') &&
              c.is_active !== false,
          ),
        ),
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = contracts.find((c) => c.id === where.id);
          if (row) Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
    },
    profiles: {
      findMany: jest.fn(() => Promise.resolve(options.admins ?? [])),
    },
    contract_expiry_notifications: notifTable,
    // Transacción simulada: si el callback lanza, se revierten los inserts
    // hechos durante él (suficiente para probar el rollback correo-fallido).
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const before = notifications.length;
      try {
        return await fn({ contract_expiry_notifications: notifTable });
      } catch (err) {
        notifications.length = before;
        throw err;
      }
    }),
  };

  const emailService = {
    renderTemplate: jest.fn((template: string) => ({
      subject: `[test] ${template}`,
      body: '<html></html>',
    })),
    sendEmail: jest.fn(({ to }: { to: { email: string } }) => {
      if (failEmails) {
        return Promise.resolve({ success: false, error: 'smtp caído' });
      }
      emailsSent.push({ to: to.email, template: '' });
      return Promise.resolve({ success: true, messageId: 'sim' });
    }),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'CONTRACT_ALERT_DAYS_BEFORE' ? options.daysBefore : undefined,
    ),
  };

  const service = new ContractExpiryService(
    prisma as unknown as PrismaService,
    emailService as unknown as EmailService,
    config as unknown as ConfigService,
  );
  return {
    service,
    prisma,
    emailService,
    notifications,
    emailsSent,
    setFailEmails: (v: boolean) => (failEmails = v),
  };
}

const contractAt = (
  daysFromToday: number,
  overrides: Record<string, unknown> = {},
) => ({
  id: `ct-${daysFromToday}`,
  contract_number: `A3T-${daysFromToday}`,
  service_description: 'Servicio de prueba',
  status: 'vigente',
  is_active: true,
  end_date: dayAt(daysFromToday),
  total_amount: null,
  currency: 'MXN',
  responsible_user_email: 'responsable@abent3t.com',
  responsible_user_name: 'Responsable',
  suppliers: { legal_name: 'Proveedor SA' },
  profiles_contracts_buyer_profile_idToprofiles: {
    email: 'comprador@abent3t.com',
    full_name: 'Comprador',
  },
  ...overrides,
});

const ADMINS = [{ email: 'ingrid@abent3t.com', full_name: 'Ingrid' }];

describe('ContractExpiryService (reloj inyectado, umbral 45 días, diaria)', () => {
  it('umbral por env (default 45) y a 46 días no alerta', async () => {
    const { service, notifications } = makeHarness([contractAt(46)]);
    expect(service.alertDaysBefore).toBe(45);
    const result = await service.runCheck(NOW);
    expect(result.notificationsSent).toBe(0);
    expect(notifications).toHaveLength(0);

    const custom = makeHarness([contractAt(46)], { daysBefore: '60' });
    expect(custom.service.alertDaysBefore).toBe(60);
    expect((await custom.service.runCheck(NOW)).notificationsSent).toBe(2);
  });

  it('a 45 días → una alerta por destinatario: comprador + responsable + admins', async () => {
    const { service, notifications, emailsSent } = makeHarness(
      [contractAt(45)],
      { admins: ADMINS },
    );
    const result = await service.runCheck(NOW);

    expect(result.notificationsSent).toBe(3);
    expect(result.expiredMarked).toBe(0);
    expect(new Set(notifications.map((n) => n.notification_type))).toEqual(
      new Set(['expiring:2026-09-01']),
    );
    expect(notifications.map((n) => n.recipient_role).sort()).toEqual([
      'comprador',
      'contract_admin',
      'responsible_user',
    ]);
    expect(emailsSent.map((e) => e.to).sort()).toEqual([
      'comprador@abent3t.com',
      'ingrid@abent3t.com',
      'responsable@abent3t.com',
    ]);
  });

  it('segunda corrida el mismo día NO re-envía; al día siguiente SÍ (diaria)', async () => {
    const { service, emailService, notifications } = makeHarness([
      contractAt(7),
    ]);
    const first = await service.runCheck(NOW);
    expect(first.notificationsSent).toBe(2);

    const second = await service.runCheck(NOW);
    expect(second.notificationsSent).toBe(0);
    expect(second.alreadyNotified).toBe(2);
    expect(notifications).toHaveLength(2);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(2);

    const nextDay = await service.runCheck(TOMORROW);
    expect(nextDay.notificationsSent).toBe(2);
    expect(notifications).toHaveLength(4);
    expect(notifications[2].notification_type).toBe('expiring:2026-09-02');
  });

  it('día 0 → pasa a vencido y alerta "expired"; el vencido sigue alertando cada día', async () => {
    const contracts = [contractAt(0), contractAt(15)];
    const { service, notifications } = makeHarness(contracts);
    const result = await service.runCheck(NOW);

    expect(result.expiredMarked).toBe(1);
    expect(contracts[0].status).toBe('vencido');
    expect(contracts[1].status).toBe('vigente');
    // ambos alertan (15 días < 45): 2 destinatarios × 2 contratos
    expect(notifications).toHaveLength(4);
    expect(
      notifications
        .filter((n) => n.contract_id === 'ct-0')
        .every((n) => n.notification_type.startsWith('expired:')),
    ).toBe(true);

    const nextDay = await service.runCheck(TOMORROW);
    expect(nextDay.expiredMarked).toBe(0); // ya estaba vencido
    expect(nextDay.notificationsSent).toBe(4); // sigue alertando a diario
  });

  it('vencimiento que quedó atrás (server caído el día 0) también expira', async () => {
    const contracts = [contractAt(-3)];
    const { service } = makeHarness(contracts);
    const result = await service.runCheck(NOW);
    expect(result.expiredMarked).toBe(1);
    expect(contracts[0].status).toBe('vencido');
  });

  it('renovado o cancelado quedan fuera del barrido', async () => {
    const { service, prisma, notifications } = makeHarness([
      contractAt(0, { status: 'renovado' }),
      contractAt(10, { status: 'cancelado' }),
    ]);
    const result = await service.runCheck(NOW);
    expect(result.checkedContracts).toBe(0);
    expect(result.notificationsSent).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(prisma.contracts.update).not.toHaveBeenCalled();
  });

  it('correo fallido → rollback del log (se reintenta en la siguiente corrida)', async () => {
    const harness = makeHarness([contractAt(30)]);
    harness.setFailEmails(true);
    const failed = await harness.service.runCheck(NOW);
    expect(failed.notificationsSent).toBe(0);
    expect(failed.errors).toHaveLength(2);
    expect(harness.notifications).toHaveLength(0); // rollback

    harness.setFailEmails(false);
    const retry = await harness.service.runCheck(NOW);
    expect(retry.notificationsSent).toBe(2);
    expect(harness.notifications).toHaveLength(2);
  });

  it('sin comprador asignado, solo alerta al responsable; correos repetidos se envían una vez', async () => {
    const { service, notifications } = makeHarness(
      [
        contractAt(30, {
          profiles_contracts_buyer_profile_idToprofiles: null,
        }),
      ],
      { admins: [{ email: 'Responsable@abent3t.com', full_name: 'R' }] },
    );
    const result = await service.runCheck(NOW);
    expect(result.notificationsSent).toBe(1);
    expect(notifications[0].recipient_role).toBe('responsible_user');
  });
});

describe('contracts.dates', () => {
  it('daysUntil calcula días calendario exactos contra medianoche UTC', () => {
    expect(daysUntil(dayAt(30), TODAY)).toBe(30);
    expect(daysUntil(dayAt(0), TODAY)).toBe(0);
    expect(daysUntil(dayAt(-2), TODAY)).toBe(-2);
  });

  it('cdmxDateUtc proyecta el día civil de CDMX (madrugada UTC = día anterior en CDMX)', () => {
    // 2026-09-01 03:00 UTC = 2026-08-31 21:00 CDMX (UTC-6)
    const utcEarly = new Date('2026-09-01T03:00:00Z');
    expect(cdmxDateUtc(utcEarly).toISOString().slice(0, 10)).toBe('2026-08-31');
    expect(cdmxDateUtc(NOW).toISOString().slice(0, 10)).toBe('2026-09-01');
  });
});
