import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { ExpeditingService } from './expediting.service';

/**
 * Fase Expeditación. Prisma EN MEMORIA — sin BD ni red. Cubre: job de
 * alertas -15/vencida/+7 con idempotencia, recepciones (regla 2b) y que la
 * tasa del proveedor solo cambie a través del cálculo EXISTENTE de
 * suppliers.service (replicado aquí tal cual para el assert A5).
 */

type Row = Record<string, unknown> & { id: string };

let idSeq = 0;
const nextId = () =>
  `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;

const TODAY = new Date(Date.UTC(2026, 8, 1));
const day = (offset: number) => new Date(TODAY.getTime() + offset * 86_400_000);

function makeHarness() {
  const pos: Row[] = [];
  const trackings: Row[] = [];
  const events: Row[] = [];
  const alerts: Row[] = [];
  const emails: Array<{ to: string; subject: string }> = [];

  const withIncludes = (po: Row) => ({
    ...po,
    suppliers: {
      id: po.supplier_id,
      legal_name: `Proveedor ${String(po.supplier_id)}`,
      email: 'proveedor@ext.com',
    },
    profiles: {
      id: po.buyer_id,
      full_name: 'Comprador',
      email: 'comprador@abent3t.com',
    },
    requisitions: { id: 'rq-1', rq_number: 'RQ001' },
    delivery_tracking:
      trackings.find((t) => t.purchase_order_id === po.id) ?? null,
  });

  const prisma = {
    purchase_orders: {
      findMany: jest.fn(
        ({ where }: { where?: Record<string, unknown> } = {}) => {
          const notIn = (
            where?.status as { notIn?: string[]; not?: string } | undefined
          )?.notIn;
          const not = (where?.status as { not?: string } | undefined)?.not;
          return Promise.resolve(
            pos
              .filter((po) => {
                if (notIn && notIn.includes(po.status as string)) return false;
                if (not && po.status === not) return false;
                return true;
              })
              .map(withIncludes),
          );
        },
      ),
      findFirst: jest.fn(({ where }: { where: { id?: string } }) => {
        const found = pos.find((po) => po.id === where.id);
        return Promise.resolve(found ? withIncludes(found) : null);
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = pos.find((po) => po.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
    },
    delivery_tracking: {
      findFirst: jest.fn(
        ({ where }: { where: { purchase_order_id?: string } }) =>
          Promise.resolve(
            trackings.find(
              (t) => t.purchase_order_id === where.purchase_order_id,
            ) ?? null,
          ),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: nextId(),
          current_status: 'pendiente',
          alert_count: 0,
          ...data,
        };
        trackings.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = trackings.find((t) => t.id === where.id)!;
          const { alert_count, ...rest } = data as {
            alert_count?: { increment: number };
          } & Record<string, unknown>;
          Object.assign(row, rest);
          if (alert_count?.increment) {
            row.alert_count =
              (row.alert_count as number) + alert_count.increment;
          }
          return Promise.resolve(row);
        },
      ),
    },
    delivery_tracking_events: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: nextId(), created_at: new Date(), ...data };
        events.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn(() => Promise.resolve([...events])),
    },
    expediting_alerts: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const duplicate = alerts.some(
          (a) =>
            a.delivery_tracking_id === data.delivery_tracking_id &&
            a.alert_type === data.alert_type &&
            (a.alert_date as Date).getTime() ===
              (data.alert_date as Date).getTime(),
        );
        if (duplicate) {
          return Promise.reject(
            Object.assign(new Error('unique'), { code: 'P2002' }),
          );
        }
        const row: Row = { id: nextId(), sent_at: new Date(), ...data };
        alerts.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn(() => Promise.resolve([...alerts])),
    },
    profiles: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { email: 'lider@abent3t.com', full_name: 'Lider Procura' },
        ]),
      ),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );

  const email = {
    sendEmail: jest.fn(
      ({ to, subject }: { to: { email: string }; subject: string }) => {
        emails.push({ to: to.email, subject });
        return Promise.resolve({ success: true, messageId: 'sim' });
      },
    ),
  };

  const service = new ExpeditingService(
    prisma as unknown as PrismaService,
    email as unknown as EmailService,
  );

  const addPo = (overrides: Record<string, unknown> = {}) => {
    const row: Row = {
      id: nextId(),
      po_number: `PO-${idSeq}`,
      status: 'emitida',
      supplier_id: 's-1',
      buyer_id: 'b-1',
      amount: '1000.00',
      expected_delivery_date: day(30),
      actual_delivery_date: null,
      is_active: true,
      ...overrides,
    };
    pos.push(row);
    return row;
  };

  return { service, prisma, pos, trackings, events, alerts, emails, addPo };
}

/** Réplica EXACTA del cálculo de suppliers.service (assert A5). */
function onTimeRate(pos: Row[]): number {
  const delivered = pos.filter((po) => po.status === 'entregada_completa');
  const onTime = delivered.filter(
    (po) =>
      po.actual_delivery_date &&
      po.expected_delivery_date &&
      new Date(po.actual_delivery_date as Date) <=
        new Date(po.expected_delivery_date as Date),
  );
  return delivered.length > 0
    ? Math.round((onTime.length / delivered.length) * 100)
    : 0;
}

describe('ExpeditingService — job de alertas (T9)', () => {
  it('preventiva a ≤15 días: una sola vez por fecha esperada (idempotente)', async () => {
    const h = makeHarness();
    h.addPo({ expected_delivery_date: day(10) });

    const first = await h.service.runAlertCheck(TODAY);
    expect(first.sent).toBe(1);
    expect(h.alerts[0].alert_type).toBe('preventiva');
    expect(h.emails.map((e) => e.to).sort()).toEqual([
      'comprador@abent3t.com',
      'proveedor@ext.com',
    ]);

    // Mismo día y también días después: sigue siendo la misma fecha esperada
    const again = await h.service.runAlertCheck(TODAY);
    expect(again.sent).toBe(0);
    expect(again.alreadySent).toBe(1);
    const later = await h.service.runAlertCheck(day(3));
    expect(later.sent).toBe(0);
    expect(h.alerts).toHaveLength(1);
  });

  it('vencida (días 1..6): recordatorio una vez; desde +7: crítica DIARIA con supervisor', async () => {
    const h = makeHarness();
    h.addPo({ expected_delivery_date: day(-2) });

    const reminder = await h.service.runAlertCheck(TODAY);
    expect(reminder.sent).toBe(1);
    expect(h.alerts[0].alert_type).toBe('recordatorio');
    const reminderAgain = await h.service.runAlertCheck(day(2)); // día -4… sigue <7
    expect(reminderAgain.sent).toBe(0);

    h.emails.length = 0;
    const critical1 = await h.service.runAlertCheck(day(6)); // 8 días vencida
    expect(critical1.sent).toBe(1);
    expect(h.alerts.at(-1)?.alert_type).toBe('critica');
    // supervisor incluido en crítica
    expect(h.emails.some((e) => e.to === 'lider@abent3t.com')).toBe(true);

    const critical2 = await h.service.runAlertCheck(day(7)); // día siguiente
    expect(critical2.sent).toBe(1); // diaria: nueva fecha-clave
    const critical2again = await h.service.runAlertCheck(day(7));
    expect(critical2again.sent).toBe(0); // idempotente en el mismo día
  });

  it('entregadas y canceladas quedan fuera del barrido', async () => {
    const h = makeHarness();
    h.addPo({ status: 'entregada_completa', expected_delivery_date: day(-30) });
    h.addPo({ status: 'cancelada', expected_delivery_date: day(-30) });
    const result = await h.service.runAlertCheck(TODAY);
    expect(result.checked).toBe(0);
    expect(result.sent).toBe(0);
  });

  it('reprogramar rearma la preventiva para la nueva fecha esperada', async () => {
    const h = makeHarness();
    const po = h.addPo({ expected_delivery_date: day(5) });
    await h.service.runAlertCheck(TODAY); // preventiva de la fecha original
    await h.service.reschedule(
      po.id,
      {
        new_expected_date: day(40).toISOString().slice(0, 10),
        reason: 'Proveedor pidió prórroga',
      },
      'u-1',
    );
    // 26 días después, la nueva fecha entra a ventana → nueva preventiva
    const result = await h.service.runAlertCheck(day(26));
    expect(result.sent).toBe(1);
    expect(h.alerts).toHaveLength(2);
  });
});

describe('ExpeditingService — recepciones (regla 2b) y tasa del proveedor (A5)', () => {
  it('recepción parcial → tracking/PO en parcial; total → actual_delivery_date + entregada_completa', async () => {
    const h = makeHarness();
    const po = h.addPo({ expected_delivery_date: day(3) });

    await h.service.registerFollowUp(
      po.id,
      { note: 'Proveedor confirma embarque' },
      'u-1',
    );
    await h.service.registerReceipt(
      po.id,
      {
        type: 'parcial',
        received_date: day(1).toISOString().slice(0, 10),
        quantity: 5,
        comment: 'Primera parte',
      },
      'u-1',
    );
    expect(po.status).toBe('entregada_parcial');
    expect(h.trackings[0].current_status).toBe('entregada_parcial');

    await h.service.registerReceipt(
      po.id,
      { type: 'total', received_date: day(2).toISOString().slice(0, 10) },
      'u-1',
    );
    expect(po.status).toBe('entregada_completa');
    expect((po.actual_delivery_date as Date).getTime()).toBe(day(2).getTime());
    expect(h.trackings[0].current_status).toBe('entregada');
    expect(h.trackings[0].confirmed_by).toBe('u-1');
    expect(h.events.map((e) => e.event_type)).toEqual([
      'seguimiento',
      'recepcion_parcial',
      'recepcion_total',
    ]);

    // Doble recepción total → error claro
    await expect(
      h.service.registerReceipt(
        po.id,
        { type: 'total', received_date: day(3).toISOString().slice(0, 10) },
        'u-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('A5: la tasa on-time del proveedor cambia SOLO por el cálculo existente', async () => {
    const h = makeHarness();
    const late = h.addPo({ expected_delivery_date: day(-5) });
    const onTime = h.addPo({ expected_delivery_date: day(10) });
    expect(onTimeRate(h.pos)).toBe(0); // nada entregado aún

    // Entrega TARDE (esperada hace 5 días, recibida hoy) → 0% con 1 entregada
    await h.service.registerReceipt(
      late.id,
      { type: 'total', received_date: TODAY.toISOString().slice(0, 10) },
      'u-1',
    );
    expect(onTimeRate(h.pos)).toBe(0);

    // Entrega A TIEMPO → 50% (1 de 2)
    await h.service.registerReceipt(
      onTime.id,
      { type: 'total', received_date: day(9).toISOString().slice(0, 10) },
      'u-1',
    );
    expect(onTimeRate(h.pos)).toBe(50);
  });

  it('la reprogramación NO toca la fecha original de la PO (la tasa se mide contra ella)', async () => {
    const h = makeHarness();
    const po = h.addPo({ expected_delivery_date: day(2) });
    await h.service.reschedule(
      po.id,
      {
        new_expected_date: day(20).toISOString().slice(0, 10),
        reason: 'Retraso del transportista',
      },
      'u-1',
    );
    expect((po.expected_delivery_date as Date).getTime()).toBe(
      day(2).getTime(),
    );
    expect((h.trackings[0].expected_date as Date).getTime()).toBe(
      day(20).getTime(),
    );
    const event = h.events.find((e) => e.event_type === 'reprogramacion')!;
    expect((event.previous_expected_date as Date).getTime()).toBe(
      day(2).getTime(),
    );
    expect((event.new_expected_date as Date).getTime()).toBe(day(20).getTime());
  });

  it('PO sin fecha esperada: el seguimiento pide capturarla reprogramando', async () => {
    const h = makeHarness();
    const po = h.addPo({ expected_delivery_date: null });
    await expect(
      h.service.registerFollowUp(
        po.id,
        { note: 'Llamada al proveedor' },
        'u-1',
      ),
    ).rejects.toThrow('captúrala reprogramando');
    // Reprogramar SÍ funciona (usa la nueva fecha como fallback)
    await h.service.reschedule(
      po.id,
      {
        new_expected_date: day(15).toISOString().slice(0, 10),
        reason: 'Fecha acordada con proveedor',
      },
      'u-1',
    );
    expect(h.trackings).toHaveLength(1);
  });
});
