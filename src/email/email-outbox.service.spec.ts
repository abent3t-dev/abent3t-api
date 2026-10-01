import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import {
  EmailOutboxService,
  MAX_ATTEMPTS,
  RETRY_DELAY_MS,
  cdmxDayStart,
} from './email-outbox.service';
import type {
  DeliveryResult,
  EmailTransportService,
  OutgoingEmail,
} from './email-transport.service';

/**
 * J1 (hilo con César, 2026-10-01) — Cola de correo probada con BD en memoria
 * y reloj INYECTADO: cero red, cero correos reales. Cubre lo que pide
 * "Terminado cuando": idempotencia, ritmo, tope, pausa manual y rechazo de
 * dominio externo; además reintentos y la recuperación al arrancar.
 */

/** 2026-10-01 15:00 UTC = 09:00 CDMX. */
const T0 = new Date('2026-10-01T15:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const ADMIN_ID = 'dc133188-afed-4c8c-bdb6-34ca3253ca0e';

interface OutboxRow {
  id: string;
  idempotency_key: string;
  template: string;
  entity_type: string | null;
  entity_id: string | null;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  body: string;
  is_html: boolean;
  status: string;
  attempts: number;
  last_error: string | null;
  transport: string | null;
  provider_message_id: string | null;
  created_at: Date;
  scheduled_at: Date;
  last_attempt_at: Date | null;
  sent_at: Date | null;
  updated_at: Date;
}

interface SettingsRow {
  id: number;
  paused: boolean;
  paused_reason: string | null;
  paused_at: Date | null;
  paused_by: string | null;
  updated_at: Date;
}

type Where = Record<string, unknown>;

/** Igualdad, `in`, `gte`, `lte` y `lt`: lo que usa el servicio. */
function matchValue(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
    return value === cond;
  }
  const c = cond as Record<string, unknown>;
  if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
  const time = value instanceof Date ? value.getTime() : null;
  if ('gte' in c && (time === null || time < (c.gte as Date).getTime())) {
    return false;
  }
  if ('lte' in c && (time === null || time > (c.lte as Date).getTime())) {
    return false;
  }
  if ('lt' in c && (time === null || time >= (c.lt as Date).getTime())) {
    return false;
  }
  return true;
}

const matches = (row: OutboxRow, where: Where = {}) =>
  Object.entries(where).every(([field, cond]) =>
    matchValue((row as unknown as Record<string, unknown>)[field], cond),
  );

function makeHarness(
  env: Record<string, string> = {},
  deliver?: (email: OutgoingEmail) => Promise<DeliveryResult>,
) {
  /** Reloj de la "BD" (defaults now() de created_at / scheduled_at). */
  const clock = { now: T0 };
  const rows: OutboxRow[] = [];
  let settings: SettingsRow | null = null;
  let seq = 0;

  const apply = (row: OutboxRow, data: Record<string, unknown>) => {
    const target = row as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) {
        target[field] =
          (target[field] as number) +
          (value as { increment: number }).increment;
      } else {
        target[field] = value;
      }
    }
    row.updated_at = clock.now;
  };

  const outbox = {
    // createMany con skipDuplicates = ON CONFLICT DO NOTHING
    createMany: jest.fn(
      ({
        data,
        skipDuplicates,
      }: {
        data: Array<Partial<OutboxRow>>;
        skipDuplicates?: boolean;
      }) => {
        let count = 0;
        for (const d of data) {
          if (rows.some((r) => r.idempotency_key === d.idempotency_key)) {
            if (skipDuplicates) continue;
            return Promise.reject(new Error('P2002 uq_email_outbox_key'));
          }
          rows.push({
            id: `m${++seq}`,
            idempotency_key: '',
            template: '',
            entity_type: null,
            entity_id: null,
            recipient_email: '',
            recipient_name: null,
            subject: '',
            body: '',
            is_html: true,
            status: 'pendiente',
            attempts: 0,
            last_error: null,
            transport: null,
            provider_message_id: null,
            created_at: clock.now,
            scheduled_at: clock.now,
            last_attempt_at: null,
            sent_at: null,
            updated_at: clock.now,
            ...d,
          } as OutboxRow);
          count += 1;
        }
        return Promise.resolve({ count });
      },
    ),
    findFirst: jest.fn(({ where }: { where: Where }) => {
      const due = rows
        .filter((r) => matches(r, where))
        .sort(
          (a, b) =>
            a.scheduled_at.getTime() - b.scheduled_at.getTime() ||
            a.created_at.getTime() - b.created_at.getTime(),
        );
      return Promise.resolve(due[0] ? { ...due[0] } : null);
    }),
    updateMany: jest.fn(
      ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => apply(r, data));
        return Promise.resolve({ count: hit.length });
      },
    ),
    update: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) return Promise.reject(new Error('P2025'));
        apply(row, data);
        return Promise.resolve({ ...row });
      },
    ),
    count: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(rows.filter((r) => matches(r, where)).length),
    ),
    aggregate: jest.fn(() => {
      const times = rows
        .map((r) => r.last_attempt_at)
        .filter((d): d is Date => d instanceof Date)
        .map((d) => d.getTime());
      return Promise.resolve({
        _max: {
          last_attempt_at: times.length ? new Date(Math.max(...times)) : null,
        },
      });
    }),
  };

  const emailSettings = {
    findUnique: jest.fn(() =>
      Promise.resolve(settings ? { ...settings } : null),
    ),
    upsert: jest.fn(
      ({
        create,
        update,
      }: {
        create: Omit<SettingsRow, 'updated_at'>;
        update: Partial<SettingsRow>;
      }) => {
        settings = settings
          ? { ...settings, ...update, updated_at: clock.now }
          : { ...create, updated_at: clock.now };
        return Promise.resolve({ ...settings });
      },
    ),
  };

  const profiles = {
    findFirst: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === ADMIN_ID ? { id: ADMIN_ID, full_name: 'Diego' } : null,
      ),
    ),
  };

  const prisma = {
    email_outbox: outbox,
    email_settings: emailSettings,
    profiles,
  } as unknown as PrismaService;

  const config = new ConfigService({
    ALLOWED_EMAIL_DOMAIN: 'abent3t.com',
    ...env,
  });

  const delivered: OutgoingEmail[] = [];
  const transport = {
    mode: 'simulacion',
    info: () => ({
      mode: 'simulacion',
      from: 'noreply@abent3t.com',
      ready: true,
      missing: [],
    }),
    deliver: jest.fn((email: OutgoingEmail) => {
      delivered.push(email);
      return deliver
        ? deliver(email)
        : Promise.resolve<DeliveryResult>({
            status: 'simulado',
            transport: 'simulacion',
            messageId: `sim-${delivered.length}`,
          });
    }),
  } as unknown as EmailTransportService;

  const service = new EmailOutboxService(prisma, config, transport);
  return { service, rows, delivered, clock, outbox, transport };
}

const aviso = (
  to: string,
  overrides: Partial<{
    template: string;
    entityId: string;
    at: Date;
  }> = {},
) => ({
  template: overrides.template ?? 'contract_digest',
  entityType: 'contratos',
  entityId: overrides.entityId ?? 'resumen',
  to: { email: to, name: 'Persona' },
  subject: `Aviso para ${to}`,
  body: '<p>Hola</p>',
  at: overrides.at ?? T0,
});

describe('cola de correo (J1)', () => {
  describe('idempotencia', () => {
    it('el mismo aviso dos veces el mismo día da un solo registro', async () => {
      const h = makeHarness();
      const first = await h.service.enqueue(aviso('ingrid@abent3t.com'));
      const second = await h.service.enqueue(
        aviso('INGRID@abent3t.com ', { at: at(3600) }),
      );

      expect(first.status).toBe('pendiente');
      expect(second.status).toBe('duplicado');
      expect(second.key).toBe(first.key);
      expect(first.key).toBe(
        'contract_digest:contratos:resumen:ingrid@abent3t.com:2026-10-01',
      );
      expect(h.rows).toHaveLength(1);
    });

    it('otro día, otra persona u otra entidad sí son registros nuevos', async () => {
      const h = makeHarness();
      await h.service.enqueue(aviso('ingrid@abent3t.com'));
      // 2026-10-02 00:30 CDMX (06:30 UTC) ya es otro día
      await h.service.enqueue(
        aviso('ingrid@abent3t.com', { at: new Date('2026-10-02T06:30:00Z') }),
      );
      await h.service.enqueue(aviso('diana@abent3t.com'));
      await h.service.enqueue(
        aviso('ingrid@abent3t.com', {
          template: 'committee_turn',
          entityId: 'c1:v1:n1',
        }),
      );

      expect(h.rows).toHaveLength(4);
      // 2026-10-01 23:30 CDMX (05:30 UTC del 2) sigue siendo el día 1
      const sameDay = await h.service.enqueue(
        aviso('ingrid@abent3t.com', { at: new Date('2026-10-02T05:30:00Z') }),
      );
      expect(sameDay.status).toBe('duplicado');
    });

    it('dentro de la transacción del llamador usa ese cliente', async () => {
      const h = makeHarness();
      const tx = {
        email_outbox: {
          createMany: jest.fn(() => Promise.resolve({ count: 1 })),
        },
      };
      const result = await h.service.enqueue(
        aviso('ingrid@abent3t.com'),
        tx as never,
      );

      expect(result.status).toBe('pendiente');
      expect(tx.email_outbox.createMany).toHaveBeenCalledTimes(1);
      expect(h.outbox.createMany).not.toHaveBeenCalled();
    });
  });

  describe('ritmo', () => {
    it('dos envíos respetan el intervalo (default 120 s)', async () => {
      const h = makeHarness();
      await h.service.enqueue(aviso('ingrid@abent3t.com'));
      await h.service.enqueue(aviso('diana@abent3t.com'));

      expect((await h.service.processNext(at(0))).outcome).toBe('simulado');
      expect((await h.service.processNext(at(60))).outcome).toBe('ritmo');
      expect((await h.service.processNext(at(119))).outcome).toBe('ritmo');
      expect((await h.service.processNext(at(120))).outcome).toBe('simulado');

      const sent = h.rows
        .filter((r) => r.status === 'simulado')
        .map((r) => (r.sent_at as Date).getTime())
        .sort((a, b) => a - b);
      expect(sent).toHaveLength(2);
      expect(sent[1] - sent[0]).toBeGreaterThanOrEqual(120_000);
      expect(h.delivered.map((d) => d.to.email)).toEqual([
        'ingrid@abent3t.com',
        'diana@abent3t.com',
      ]);
    });

    it('EMAIL_MIN_INTERVAL_SECONDS cambia el intervalo', async () => {
      const h = makeHarness({ EMAIL_MIN_INTERVAL_SECONDS: '30' });
      await h.service.enqueue(aviso('ingrid@abent3t.com'));
      await h.service.enqueue(aviso('diana@abent3t.com'));

      expect((await h.service.processNext(at(0))).outcome).toBe('simulado');
      expect((await h.service.processNext(at(29))).outcome).toBe('ritmo');
      expect((await h.service.processNext(at(30))).outcome).toBe('simulado');
    });

    it('sin pendientes no hay nada que sacar', async () => {
      const h = makeHarness();
      expect((await h.service.processNext(at(0))).outcome).toBe('vacio');
    });
  });

  describe('tope diario', () => {
    it('al llegar al tope se pausa solo y lo que falta sale al día siguiente', async () => {
      const h = makeHarness({
        EMAIL_DAILY_CAP: '2',
        EMAIL_MIN_INTERVAL_SECONDS: '1',
      });
      for (const to of ['a', 'b', 'c']) {
        await h.service.enqueue(aviso(`${to}@abent3t.com`));
      }

      expect((await h.service.processNext(at(0))).outcome).toBe('simulado');
      expect((await h.service.processNext(at(10))).outcome).toBe('simulado');
      expect((await h.service.processNext(at(20))).outcome).toBe('tope');
      expect((await h.service.processNext(at(3600))).outcome).toBe('tope');
      expect(h.rows.filter((r) => r.status === 'pendiente')).toHaveLength(1);

      // La app lo avisa: el estado queda en "tope"
      const state = await h.service.status(at(30));
      expect(state.state).toBe('tope');
      expect(state.sent_today).toBe(2);
      expect(state.daily_cap).toBe(2);
      expect(state.pending).toBe(1);

      // Día siguiente (CDMX): sale el que faltaba
      const tomorrow = new Date('2026-10-02T14:00:00Z');
      expect((await h.service.processNext(tomorrow)).outcome).toBe('simulado');
      expect(h.rows.filter((r) => r.status === 'pendiente')).toHaveLength(0);
      expect((await h.service.status(tomorrow)).state).toBe('activo');
    });

    it('lo simulado cuenta al tope, igual que lo enviado', async () => {
      const h = makeHarness({ EMAIL_DAILY_CAP: '1' });
      await h.service.enqueue(aviso('a@abent3t.com'));
      await h.service.enqueue(aviso('b@abent3t.com'));
      expect((await h.service.processNext(at(0))).outcome).toBe('simulado');
      expect((await h.service.processNext(at(600))).outcome).toBe('tope');
    });

    it('el día del tope es el de CDMX (UTC-6)', () => {
      expect(cdmxDayStart(new Date('2026-10-02T05:59:00Z')).toISOString()).toBe(
        '2026-10-01T06:00:00.000Z',
      );
      expect(cdmxDayStart(new Date('2026-10-02T06:00:00Z')).toISOString()).toBe(
        '2026-10-02T06:00:00.000Z',
      );
    });
  });

  describe('pausa manual', () => {
    it('con el interruptor en pausa no sale nada; al reanudar, sí', async () => {
      const h = makeHarness();
      await h.service.enqueue(aviso('ingrid@abent3t.com'));

      const paused = await h.service.setPaused(true, ADMIN_ID, ' Revisión ');
      expect(paused.state).toBe('pausado');
      expect(paused.paused_reason).toBe('Revisión');
      expect(paused.paused_by).toEqual({ id: ADMIN_ID, full_name: 'Diego' });

      expect((await h.service.processNext(at(0))).outcome).toBe('pausado');
      expect((await h.service.processNext(at(600))).outcome).toBe('pausado');
      expect(h.delivered).toHaveLength(0);
      expect(h.rows[0].status).toBe('pendiente');

      const resumed = await h.service.setPaused(false, ADMIN_ID);
      expect(resumed.state).toBe('activo');
      expect(resumed.paused_by).toBeNull();
      expect((await h.service.processNext(at(700))).outcome).toBe('simulado');
      expect(h.delivered).toHaveLength(1);
    });
  });

  describe('solo destinatarios internos', () => {
    it('un dominio externo se rechaza, queda registrado y no sale', async () => {
      const h = makeHarness();
      const result = await h.service.enqueue(
        aviso('ventas@proveedor.com.mx', {
          template: 'expediting_vencida',
          entityId: 'po-1',
        }),
      );

      expect(result.status).toBe('rechazado');
      expect(h.rows).toHaveLength(1);
      expect(h.rows[0].status).toBe('rechazado');
      expect(h.rows[0].last_error).toContain('@abent3t.com');
      expect((await h.service.processNext(at(0))).outcome).toBe('vacio');
      expect(h.delivered).toHaveLength(0);

      // El rechazo también es idempotente
      const again = await h.service.enqueue(
        aviso('ventas@proveedor.com.mx', {
          template: 'expediting_vencida',
          entityId: 'po-1',
        }),
      );
      expect(again.status).toBe('duplicado');
      expect((await h.service.status(at(0))).rejected_today).toBe(1);
    });

    it('un subdominio o un dominio parecido tampoco pasan', async () => {
      const h = makeHarness();
      for (const to of [
        'a@mail.abent3t.com',
        'b@abent3t.com.mx',
        'c@notabent3t.com',
      ]) {
        expect((await h.service.enqueue(aviso(to))).status).toBe('rechazado');
      }
    });

    it('ALLOWED_EMAIL_DOMAIN acepta una lista', async () => {
      const h = makeHarness({
        ALLOWED_EMAIL_DOMAIN: 'abent3t.com, @ciisa.com',
      });
      expect((await h.service.enqueue(aviso('ingrid@ciisa.com'))).status).toBe(
        'pendiente',
      );
      expect((await h.service.enqueue(aviso('alguien@gmail.com'))).status).toBe(
        'rechazado',
      );
    });

    it('si cambia el dominio permitido, lo pendiente se revisa otra vez al enviar', async () => {
      const h = makeHarness();
      await h.service.enqueue(aviso('ingrid@ciisa.com'));
      // Se encoló cuando el dominio estaba permitido (fila directa)
      h.rows.push({
        ...h.rows[0],
        id: 'm-externo',
        idempotency_key: 'k-externo',
        status: 'pendiente',
        last_error: null,
      });

      const result = await h.service.processNext(at(0));
      expect(result).toEqual({ outcome: 'rechazado', id: 'm-externo' });
      expect(h.delivered).toHaveLength(0);
    });
  });

  describe('errores y arranque', () => {
    it('un envío fallido se reintenta con espera y a los 3 intentos queda en error', async () => {
      const h = makeHarness({ EMAIL_MIN_INTERVAL_SECONDS: '1' }, () =>
        Promise.reject(new Error('Graph sendMail respondió 503')),
      );
      await h.service.enqueue(aviso('ingrid@abent3t.com'));

      const first = await h.service.processNext(at(0));
      expect(first.outcome).toBe('reintento');
      expect(h.rows[0].status).toBe('pendiente');
      expect(h.rows[0].attempts).toBe(1);
      expect(h.rows[0].scheduled_at.getTime()).toBe(
        at(0).getTime() + RETRY_DELAY_MS,
      );
      // Antes de la espera no se reintenta
      expect((await h.service.processNext(at(60))).outcome).toBe('vacio');

      const second = await h.service.processNext(
        new Date(at(0).getTime() + RETRY_DELAY_MS),
      );
      expect(second.outcome).toBe('reintento');
      const third = await h.service.processNext(
        new Date(at(0).getTime() + RETRY_DELAY_MS * 4),
      );
      expect(third.outcome).toBe('error');
      expect(h.rows[0].status).toBe('error');
      expect(h.rows[0].attempts).toBe(MAX_ATTEMPTS);
      expect(h.rows[0].last_error).toContain('503');
    });

    it('lo que quedó "enviando" vuelve a pendiente al arrancar', async () => {
      const h = makeHarness();
      await h.service.enqueue(aviso('ingrid@abent3t.com'));
      h.rows[0].status = 'enviando';

      expect(await h.service.releaseStuck()).toBe(1);
      expect(h.rows[0].status).toBe('pendiente');
      expect(await h.service.releaseStuck()).toBe(0);
    });

    it('en simulación queda "simulado" con el transporte registrado', async () => {
      const h = makeHarness();
      await h.service.enqueue(aviso('ingrid@abent3t.com'));
      await h.service.processNext(at(0));

      expect(h.rows[0]).toMatchObject({
        status: 'simulado',
        transport: 'simulacion',
        attempts: 1,
        provider_message_id: 'sim-1',
      });
      expect(h.rows[0].sent_at?.getTime()).toBe(at(0).getTime());
    });
  });
});
