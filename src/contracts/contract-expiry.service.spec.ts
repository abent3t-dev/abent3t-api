import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import type { ContractDigestItem } from '../email/email.interfaces';
import { ContractExpiryService } from './contract-expiry.service';
import { cdmxDateUtc, daysUntil } from './contracts.dates';

/**
 * Fase §15 / bloque 2026-09-23 (D11) / J2 (2026-10-01). Job de avisos
 * probado con reloj INYECTADO y Prisma simulado en memoria — cero red, cero
 * BD, cero correos reales. Alerta desde CONTRACT_ALERT_DAYS_BEFORE (45) días
 * antes y DIARIA hasta que el contrato se renueve o cierre; al día 0 pasa a
 * vencido y sigue en el aviso como vencido. J2: un solo RESUMEN por persona
 * y día, y los vencidos históricos no alertan.
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

interface DigestSent {
  to: string;
  subject: string;
  porVencer: ContractDigestItem[];
  vencidos: ContractDigestItem[];
}

function makeHarness(
  contracts: Array<Record<string, unknown>>,
  options: {
    admins?: Array<{ email: string; full_name: string | null }>;
    daysBefore?: string;
  } = {},
) {
  const notifications: NotifRow[] = [];
  const digests: DigestSent[] = [];
  const outboxKeys = new Set<string>();
  let failEmails = false;
  let lastRendered: {
    porVencer: ContractDigestItem[];
    vencidos: ContractDigestItem[];
  } = { porVencer: [], vencidos: [] };

  const key = (n: NotifRow) =>
    `${n.contract_id}|${n.notification_type}|${n.recipient_email}`;
  const notifTable = {
    // createMany con skipDuplicates = ON CONFLICT DO NOTHING
    createMany: jest.fn(
      ({ data }: { data: NotifRow[]; skipDuplicates?: boolean }) => {
        const existing = new Set(notifications.map(key));
        let count = 0;
        for (const row of data) {
          if (existing.has(key(row))) continue;
          notifications.push({ ...row });
          existing.add(key(row));
          count += 1;
        }
        return Promise.resolve({ count });
      },
    ),
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
    renderTemplate: jest.fn(
      (
        _template: string,
        data: {
          porVencer: ContractDigestItem[];
          vencidos: ContractDigestItem[];
        },
      ) => {
        lastRendered = { porVencer: data.porVencer, vencidos: data.vencidos };
        return { subject: `[test] resumen`, body: '<html></html>' };
      },
    ),
    // J1: el resumen va a la cola con la llave del día (destinatario + día)
    enqueue: jest.fn(
      ({
        to,
        subject,
        at,
      }: {
        to: { email: string };
        subject: string;
        at: Date;
      }) => {
        if (failEmails) {
          return Promise.reject(new Error('BD caída al encolar'));
        }
        const key = `${to.email}|${cdmxDateUtc(at).toISOString().slice(0, 10)}`;
        if (outboxKeys.has(key)) {
          return Promise.resolve({ status: 'duplicado', key });
        }
        outboxKeys.add(key);
        digests.push({ to: to.email, subject, ...lastRendered });
        return Promise.resolve({ status: 'pendiente', key });
      },
    ),
  };
  const config = {
    get: jest.fn((name: string) =>
      name === 'CONTRACT_ALERT_DAYS_BEFORE' ? options.daysBefore : undefined,
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
    digests,
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
  status: daysFromToday < 0 ? 'vencido' : 'vigente',
  vencido_historico: false,
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

const numbers = (items: ContractDigestItem[]) =>
  items.map((i) => i.contractNumber);

describe('ContractExpiryService — resumen diario por persona (J2)', () => {
  it('umbral por env (default 45) y a 46 días no alerta', async () => {
    const { service, notifications, digests } = makeHarness([contractAt(46)]);
    expect(service.alertDaysBefore).toBe(45);
    const result = await service.runCheck(NOW);
    expect(result.digestsQueued).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(digests).toHaveLength(0);

    const custom = makeHarness([contractAt(46)], { daysBefore: '60' });
    expect(custom.service.alertDaysBefore).toBe(60);
    expect((await custom.service.runCheck(NOW)).digestsQueued).toBe(2);
  });

  it('UN resumen por persona con todos sus contratos: por vencer y vencidos sin renovar', async () => {
    const { service, notifications, digests } = makeHarness(
      [contractAt(30), contractAt(10), contractAt(-5), contractAt(-2)],
      { admins: ADMINS },
    );
    const result = await service.runCheck(NOW);

    // comprador, responsable y lider_procura: un correo cada uno, no 12
    expect(result.digestsQueued).toBe(3);
    expect(result.alertingContracts).toBe(4);
    expect(digests.map((d) => d.to).sort()).toEqual([
      'comprador@abent3t.com',
      'ingrid@abent3t.com',
      'responsable@abent3t.com',
    ]);
    const ingrid = digests.find((d) => d.to === 'ingrid@abent3t.com')!;
    // por vencer: el más próximo primero; vencidos: el más antiguo primero
    expect(numbers(ingrid.porVencer)).toEqual(['A3T-10', 'A3T-30']);
    expect(numbers(ingrid.vencidos)).toEqual(['A3T--5', 'A3T--2']);
    // trazabilidad por contrato: una fila por contrato y destinatario
    expect(notifications).toHaveLength(12);
    expect(new Set(notifications.map((n) => n.notification_type))).toEqual(
      new Set(['expiring:2026-09-01', 'expired:2026-09-01']),
    );
  });

  it('los vencidos históricos no alertan; los que vencen de aquí en adelante sí', async () => {
    const contracts = [
      contractAt(-400, { vencido_historico: true }),
      contractAt(-90, { vencido_historico: true }),
      contractAt(-3), // venció después de la carga: sigue avisando
      contractAt(20),
    ];
    const { service, digests } = makeHarness(contracts, { admins: ADMINS });
    const result = await service.runCheck(NOW);

    expect(result.historicSkipped).toBe(2);
    expect(result.alertingContracts).toBe(2);
    const ingrid = digests.find((d) => d.to === 'ingrid@abent3t.com')!;
    expect(numbers(ingrid.vencidos)).toEqual(['A3T--3']);
    expect(numbers(ingrid.porVencer)).toEqual(['A3T-20']);
    const all = digests.flatMap((d) => [...d.porVencer, ...d.vencidos]);
    expect(numbers(all)).not.toContain('A3T--400');
    expect(numbers(all)).not.toContain('A3T--90');
  });

  it('solo históricos: nadie recibe correo', async () => {
    const { service, digests, notifications } = makeHarness(
      [contractAt(-400, { vencido_historico: true })],
      { admins: ADMINS },
    );
    const result = await service.runCheck(NOW);
    expect(result.digestsQueued).toBe(0);
    expect(digests).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it('segunda corrida el mismo día NO re-envía; al día siguiente SÍ (diaria)', async () => {
    const { service, emailService, notifications } = makeHarness([
      contractAt(7),
      contractAt(8),
    ]);
    const first = await service.runCheck(NOW);
    expect(first.digestsQueued).toBe(2);

    const second = await service.runCheck(NOW);
    expect(second.digestsQueued).toBe(0);
    expect(second.alreadyNotified).toBe(2);
    expect(notifications).toHaveLength(4);
    expect(emailService.enqueue).toHaveBeenCalledTimes(2);

    const nextDay = await service.runCheck(TOMORROW);
    expect(nextDay.digestsQueued).toBe(2);
    expect(notifications).toHaveLength(8);
    expect(notifications[4].notification_type).toBe('expiring:2026-09-02');
  });

  it('día 0 → pasa a vencido y entra como vencido; al día siguiente sigue en el resumen', async () => {
    const contracts = [contractAt(0), contractAt(15)];
    const { service, digests } = makeHarness(contracts);
    const result = await service.runCheck(NOW);

    expect(result.expiredMarked).toBe(1);
    expect(contracts[0].status).toBe('vencido');
    expect(contracts[1].status).toBe('vigente');
    const buyer = digests.find((d) => d.to === 'comprador@abent3t.com')!;
    expect(numbers(buyer.vencidos)).toEqual(['A3T-0']);
    expect(numbers(buyer.porVencer)).toEqual(['A3T-15']);

    const nextDay = await service.runCheck(TOMORROW);
    expect(nextDay.expiredMarked).toBe(0); // ya estaba vencido
    expect(nextDay.digestsQueued).toBe(2); // sigue avisando a diario
  });

  it('vencimiento que quedó atrás (server caído el día 0) también expira', async () => {
    const contracts = [contractAt(-3, { status: 'vigente' })];
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
    expect(result.digestsQueued).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(prisma.contracts.update).not.toHaveBeenCalled();
  });

  it('I6: sin fecha de fin (permanente, "por servicio") no hay vencimiento ni avisos', async () => {
    const { service, prisma, notifications } = makeHarness([
      contractAt(0, { id: 'sin-fin', end_date: null }),
    ]);
    const result = await service.runCheck(NOW);
    const args = (
      prisma.contracts.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0];
    expect(args.where.end_date).toEqual({ not: null });
    // aunque la consulta lo dejara pasar, el job lo salta sin tocarlo
    expect(result.digestsQueued).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(prisma.contracts.update).not.toHaveBeenCalled();
  });

  it('si encolar falla → rollback del registro (se reintenta en la siguiente corrida)', async () => {
    const harness = makeHarness([contractAt(30)]);
    harness.setFailEmails(true);
    const failed = await harness.service.runCheck(NOW);
    expect(failed.digestsQueued).toBe(0);
    expect(failed.errors).toHaveLength(2);
    expect(harness.notifications).toHaveLength(0); // rollback

    harness.setFailEmails(false);
    const retry = await harness.service.runCheck(NOW);
    expect(retry.digestsQueued).toBe(2);
    expect(harness.notifications).toHaveLength(2);
  });

  it('sin comprador asignado, solo el responsable; un correo repetido entre roles sale una vez', async () => {
    const { service, notifications, digests } = makeHarness(
      [
        contractAt(30, {
          profiles_contracts_buyer_profile_idToprofiles: null,
        }),
      ],
      { admins: [{ email: 'Responsable@abent3t.com', full_name: 'R' }] },
    );
    const result = await service.runCheck(NOW);
    expect(result.digestsQueued).toBe(1);
    expect(digests.map((d) => d.to)).toEqual(['responsable@abent3t.com']);
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

describe('ContractExpiryService — con la cola de correo (J1)', () => {
  it('el resumen va a la cola con la plantilla, la entidad y el día del aviso', async () => {
    const { service, emailService } = makeHarness([contractAt(10)], {
      admins: ADMINS,
    });
    await service.runCheck(NOW);
    const call = (
      emailService.enqueue.mock.calls[0] as unknown as [
        Record<string, unknown>,
        unknown,
      ]
    )[0];
    expect(call).toMatchObject({
      template: 'contract_digest',
      entityType: 'contratos',
      entityId: 'resumen',
      at: NOW,
    });
    // dentro de la transacción del registro por contrato
    expect(
      (emailService.enqueue.mock.calls[0] as unknown as unknown[])[1],
    ).toBeDefined();
  });

  it('si la llave del día ya estaba en la cola, no se registra nada más (un correo por persona y día)', async () => {
    const contracts: Array<Record<string, unknown>> = [contractAt(10)];
    const harness = makeHarness(contracts);
    await harness.service.runCheck(NOW);
    expect(harness.digests).toHaveLength(2);
    expect(harness.notifications).toHaveLength(2);

    // un contrato nuevo entra el mismo día: el resumen de hoy ya salió
    contracts.push(contractAt(12));
    const again = await harness.service.runCheck(NOW);
    expect(again.digestsQueued).toBe(0);
    expect(again.alreadyNotified).toBe(2);
    expect(harness.digests).toHaveLength(2);
    // las filas del contrato nuevo se revierten: entran en el de mañana
    expect(harness.notifications).toHaveLength(2);
  });
});
