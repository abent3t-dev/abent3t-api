import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { ExpeditingService } from './expediting.service';
import { cdmxDateUtc } from '../contracts/contracts.dates';

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
    // OC abiertas de SAP y de Maximo (B6), en ese orden
    $queryRaw: jest.fn().mockResolvedValue([]),
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

  const aliases = {
    resolveMany: jest.fn().mockResolvedValue(new Map<string, string>()),
    displayName: jest.fn((_s: string, code: string | null) =>
      Promise.resolve(code),
    ),
    forProfiles: jest.fn().mockResolvedValue([]),
    byCode: jest.fn().mockResolvedValue(new Map()),
  };
  const service = new ExpeditingService(
    prisma as unknown as PrismaService,
    email as unknown as EmailService,
    aliases as unknown as ErpAliasesService,
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

  return {
    service,
    prisma,
    aliases,
    pos,
    trackings,
    events,
    alerts,
    emails,
    addPo,
  };
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

describe('ExpeditingService — filtro tipo Excel, retraso y comprador (E1/E3/E4)', () => {
  // Fechas relativas a HOY en CDMX (el servicio deriva días con la fecha real)
  const today = cdmxDateUtc();
  const rel = (days: number) => new Date(today.getTime() + days * 86_400_000);
  const erp = (overrides: Record<string, unknown>) => ({
    source: 'sap',
    external_key: '1',
    po_number: '1',
    po_status: 'bost_Open',
    supplier_name: 'Acme',
    amount: '100.00',
    currency: 'MXN',
    expected_date: rel(-31),
    requested_by: null,
    maximo_ponum: null,
    buyer_code: null,
    buyer_name: null,
    created_by_name: null,
    maximo_exists: false,
    ...overrides,
  });

  function seeded() {
    const h = makeHarness();
    h.addPo({ po_number: 'PO-ABENT', expected_delivery_date: rel(30) });
    h.prisma.$queryRaw
      .mockResolvedValueOnce([
        // migrada de Maximo: el comprador es el PURCHASEAGENT de allá
        erp({
          external_key: '10',
          po_number: '5001',
          supplier_name: 'Acme',
          expected_date: rel(-31),
          maximo_ponum: 'PO9',
          buyer_code: 'USR9',
          buyer_name: 'Compradora Nueve',
          created_by_name: 'INTEGRACION',
          maximo_exists: true,
        }),
        // migrada cuya OC en Maximo no trae comprador: no se muestra al
        // usuario de la integración que la capturó en SAP
        erp({
          external_key: '13',
          po_number: '5004',
          supplier_name: 'Delta',
          expected_date: rel(40),
          maximo_ponum: 'PO10',
          created_by_name: 'INTEGRACION',
          maximo_exists: true,
        }),
        erp({
          external_key: '11',
          po_number: '5002',
          supplier_name: 'Beta',
          expected_date: rel(-608),
          created_by_name: 'jgonzalez',
        }),
        erp({
          external_key: '12',
          po_number: '5003',
          supplier_name: 'Gamma',
          expected_date: rel(-12),
          created_by_name: 'jgonzalez',
        }),
      ])
      .mockResolvedValueOnce([
        erp({
          source: 'maximo',
          external_key: 'PO200',
          po_number: 'PO200',
          po_status: 'APPR',
          supplier_name: 'Beta',
          expected_date: rel(-48),
          buyer_code: 'VMM3',
          buyer_name: 'Victor M.',
        }),
      ]);
    h.aliases.resolveMany.mockResolvedValue(
      new Map([['VMM3', 'Víctor Martínez']]),
    );
    return h;
  }

  const ingrid = JSON.stringify({
    proveedor: { in: ['Acme', 'Beta'] },
    dias: { min: -400, max: 0 },
  });

  it('criterio de Ingrid: 2 proveedores y días -400..0 → lista, tarjetas y Excel iguales', async () => {
    let h = seeded();
    const list = await h.service.findAll({ filters: ingrid });
    expect(list.meta.total).toBe(2);
    expect(list.data.map((r) => r.po_number)).toEqual(['PO200', '5001']);

    h = seeded();
    const stats = await h.service.getStats({ filters: ingrid });
    expect(stats.total).toBe(2);
    expect(stats.counts.retrasada).toBe(2);
    expect(stats.by_source.sap.retrasada).toBe(1);
    expect(stats.by_source.maximo.retrasada).toBe(1);

    h = seeded();
    const excel = await h.service.findAllForExport({ filters: ingrid });
    expect(excel.rows.map((r) => r.po_number)).toEqual(['PO200', '5001']);
  });

  it('E3: retraso promedio de las retrasadas, total y por fuente', async () => {
    const h = seeded();
    const stats = await h.service.getStats({});
    // SAP: 31, 608, 12; Maximo: 48 → (31+608+12+48)/4
    expect(stats.avg_delay_days).toBe(174.8);
    expect(stats.avg_delay_by_source).toEqual({
      abent: null,
      sap: 217,
      maximo: 48,
    });
    expect(stats.counts.en_tiempo).toBe(2);
  });

  it('E4: comprador por fuente (alias > nombre de Maximo; SAP propia = Capturó)', async () => {
    const h = seeded();
    const { data } = await h.service.findAll({ limit: 50 });
    const byPo = new Map(data.map((r) => [r.po_number, r]));
    expect(byPo.get('PO-ABENT')).toMatchObject({
      buyer_name: 'Comprador',
      buyer_kind: 'comprador',
    });
    expect(byPo.get('5001')).toMatchObject({
      buyer_name: 'Compradora Nueve',
      buyer_kind: 'comprador',
    });
    expect(byPo.get('5002')).toMatchObject({
      buyer_name: 'jgonzalez',
      buyer_kind: 'capturo',
    });
    expect(byPo.get('PO200')).toMatchObject({
      buyer_name: 'Víctor Martínez',
      buyer_kind: 'comprador',
    });
    expect(byPo.get('5004')).toMatchObject({
      buyer_name: null,
      buyer_kind: null,
    });
  });

  it('facetas: valores con los DEMÁS filtros; rango en días', async () => {
    let h = seeded();
    const suppliers = await h.service.facets({
      column: 'proveedor',
      filters: ingrid,
    });
    // el filtro de proveedor no se aplica a su propia faceta; el de días sí
    expect(suppliers).toMatchObject({
      type: 'text',
      values: [
        { value: 'Acme', count: 1 },
        { value: 'Beta', count: 1 },
        { value: 'Gamma', count: 1 },
      ],
    });
    h = seeded();
    const days = await h.service.facets({ column: 'dias', filters: ingrid });
    expect(days).toMatchObject({ type: 'number', min: -608, max: -31 });
    h = seeded();
    const buyers = await h.service.facets({ column: 'comprador' });
    expect(buyers).toMatchObject({
      values: expect.arrayContaining([
        { value: 'Capturó: jgonzalez', count: 2 },
      ]) as unknown,
    });
  });

  it('ordena por la columna pedida y rechaza columnas desconocidas', async () => {
    let h = seeded();
    const sorted = await h.service.findAll({
      sort: 'dias',
      order: 'desc',
      limit: 50,
    });
    expect(sorted.data.map((r) => r.po_number)).toEqual([
      '5004',
      'PO-ABENT',
      '5003',
      '5001',
      'PO200',
      '5002',
    ]);
    h = seeded();
    await expect(
      h.service.findAll({ filters: JSON.stringify({ nope: { in: ['x'] } }) }),
    ).rejects.toThrow(BadRequestException);
    await expect(h.service.facets({})).rejects.toThrow(/column/);
  });
});
