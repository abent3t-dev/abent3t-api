import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { ExpeditingService } from './expediting.service';
import { poSearchNumber } from '../common/utils/po-search.util';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import { buildVendorXref } from '../erp-vendors/maximo-vendor-xref';
import { cdmxDateUtc } from '../contracts/contracts.dates';
import { EXPEDITING_COLUMNS } from './expediting.controller';

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
  const emails: Array<{ to: string; subject: string; template?: string }> = [];

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
    // J1: todo correo va a la cola de correo
    enqueue: jest.fn(
      ({
        to,
        subject,
        template,
      }: {
        to: { email: string };
        subject: string;
        template: string;
      }) => {
        emails.push({ to: to.email, subject, template });
        return Promise.resolve({ status: 'pendiente', key: template });
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
  // G1: cruce de proveedores (PO9001 de Maximo migró a SAP a nombre de NAES)
  const vendors = {
    get: jest.fn().mockResolvedValue(
      buildVendorXref(
        [
          {
            ponum: 'PO9001',
            vendor_id: 'P0000440',
            vendor_name: 'ASOCIACION MEXICANA DE ENERGIA',
            card_code: 'P0000219',
            card_name: 'NAES ENERGIA S DE RL DE CV',
          },
        ],
        new Map(),
      ),
    ),
  };
  const service = new ExpeditingService(
    prisma as unknown as PrismaService,
    email as unknown as EmailService,
    aliases as unknown as ErpAliasesService,
    vendors as unknown as MaximoVendorXrefService,
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
    maximo_created_by: null,
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

describe('ExpeditingService — comprador de respaldo de Maximo (F1)', () => {
  const today = cdmxDateUtc();
  const rel = (days: number) => new Date(today.getTime() + days * 86_400_000);
  const base = {
    po_status: 'bost_Open',
    amount: '100.00',
    currency: 'MXN',
    expected_date: rel(10),
    requested_by: null,
    maximo_ponum: null,
    buyer_code: null,
    buyer_name: null,
    created_by_name: null,
    maximo_created_by: null,
    maximo_exists: false,
  };

  it('sin PURCHASEAGENT muestra quién creó la OC en Maximo (alias), también en la SAP migrada', async () => {
    const h = makeHarness();
    h.prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          ...base,
          source: 'sap',
          external_key: '20',
          po_number: '6001',
          supplier_name: 'Acme',
          maximo_ponum: 'PO500',
          created_by_name: 'FAVOR DE NO TOCAR USUARIO PP XAMAI',
          maximo_created_by: 'VMM3',
          maximo_exists: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          ...base,
          source: 'maximo',
          external_key: 'PO600',
          po_number: 'PO600',
          po_status: 'APPR',
          supplier_name: 'Beta',
          requested_by: 'JPEREZ',
          maximo_created_by: 'AMONDRAG',
        },
        {
          ...base,
          source: 'maximo',
          external_key: 'PO601',
          po_number: 'PO601',
          po_status: 'APPR',
          supplier_name: 'Gamma',
          buyer_code: 'DYMP1',
          buyer_name: 'Diana Yohara',
          maximo_created_by: 'AMONDRAG',
        },
      ]);
    h.aliases.resolveMany.mockResolvedValue(
      new Map([
        ['VMM3', 'Víctor Martínez'],
        ['AMONDRAG', 'Ana Aurora Mondragón'],
      ]),
    );
    const { data } = await h.service.findAll({ limit: 50 });
    const byPo = new Map(data.map((r) => [r.po_number, r]));
    expect(byPo.get('6001')).toMatchObject({
      buyer_name: 'Víctor Martínez',
      buyer_kind: 'capturo',
    });
    expect(byPo.get('PO600')).toMatchObject({
      buyer_name: 'Ana Aurora Mondragón',
      buyer_kind: 'capturo',
    });
    // con PURCHASEAGENT manda el comprador aunque haya creador
    expect(byPo.get('PO601')).toMatchObject({
      buyer_name: 'Diana Yohara',
      buyer_kind: 'comprador',
    });
  });

  it('la faceta distingue comprador de "Capturó: …"', async () => {
    const h = makeHarness();
    h.prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ...base,
        source: 'maximo',
        external_key: 'PO700',
        po_number: 'PO700',
        po_status: 'APPR',
        supplier_name: 'Beta',
        buyer_code: 'DYMP1',
        buyer_name: 'Diana Yohara',
      },
      {
        ...base,
        source: 'maximo',
        external_key: 'PO701',
        po_number: 'PO701',
        po_status: 'APPR',
        supplier_name: 'Beta',
        maximo_created_by: 'DYMP1',
      },
    ]);
    h.aliases.resolveMany.mockResolvedValue(
      new Map([['DYMP1', 'Diana Yohara']]),
    );
    await expect(
      h.service.facets({ column: 'comprador', source: 'maximo' }),
    ).resolves.toMatchObject({
      values: expect.arrayContaining([
        { value: 'Diana Yohara', count: 1 },
        { value: 'Capturó: Diana Yohara', count: 1 },
      ]) as unknown,
    });
  });
});

describe('ExpeditingService — proveedor efectivo de Maximo (G1)', () => {
  const today = new Date();
  const rel = (days: number) => new Date(today.getTime() + days * 86_400_000);
  const maximoRow = {
    source: 'maximo',
    po_status: 'INPRG',
    amount: '4270000.00',
    currency: 'MXN',
    expected_date: rel(5),
    requested_by: null,
    maximo_ponum: null,
    buyer_code: null,
    buyer_name: null,
    created_by_name: null,
    maximo_created_by: null,
    maximo_exists: false,
  };

  it('la OC de Maximo migrada (su OC de SAP ya cerró) sale a nombre del proveedor de SAP y se busca por él', async () => {
    const h = makeHarness();
    h.prisma.$queryRaw.mockResolvedValue([]);
    h.prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ...maximoRow,
        external_key: 'PO9001',
        po_number: 'PO9001',
        supplier_name: 'ASOCIACION MEXICANA DE ENERGIA',
        supplier_code: 'P0000440',
      },
      {
        ...maximoRow,
        external_key: 'PO9002',
        po_number: 'PO9002',
        supplier_name: 'LOCAL SA DE CV',
        supplier_code: 'P0000500',
      },
    ]);
    const { data } = await h.service.findAll({
      search: 'naes',
      source: 'maximo',
    });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      po_number: 'PO9001',
      supplier: { legal_name: 'NAES ENERGIA S DE RL DE CV' },
      supplier_code: 'P0000219',
      supplier_note: 'en Maximo: ASOCIACION MEXICANA DE ENERGIA (P0000440)',
    });
  });
});

describe('ExpeditingService — cierre en el otro sistema y búsqueda por PO (I1/I2)', () => {
  const today = cdmxDateUtc();
  const rel = (days: number) => new Date(today.getTime() + days * 86_400_000);
  const row = (overrides: Record<string, unknown>) => ({
    source: 'sap',
    po_status: 'bost_Open',
    supplier_name: 'Desarrollos de Automática',
    supplier_code: 'P0000100',
    amount: '100.00',
    currency: 'MXN',
    expected_date: rel(-16),
    requested_by: null,
    maximo_ponum: null,
    buyer_code: null,
    buyer_name: null,
    created_by_name: null,
    maximo_created_by: null,
    maximo_exists: false,
    maximo_status: null,
    receipt_status: null,
    integration_status: null,
    ...overrides,
  });
  const copy = (
    maximo_ponum: string,
    state: { open?: boolean; closed?: boolean; cancelled?: boolean },
    doc_num: number,
  ) => ({
    maximo_ponum,
    open: state.open ?? false,
    closed: state.closed ?? false,
    cancelled: state.cancelled ?? false,
    doc_num,
  });

  /** SAP abiertas (3 migradas + 1 propia), Maximo APPR/INPRG y sus copias en SAP. */
  function seeded() {
    const h = makeHarness();
    h.prisma.$queryRaw
      .mockResolvedValueOnce([
        // migradas, abiertas en SAP: según su estatus en Maximo
        row({
          external_key: '1',
          po_number: '7001',
          maximo_ponum: 'PO104896',
          maximo_exists: true,
          maximo_status: 'INPRG',
        }),
        row({
          external_key: '2',
          po_number: '7002',
          maximo_ponum: 'PO104897',
          maximo_exists: true,
          maximo_status: 'CLOSE',
        }),
        row({
          external_key: '3',
          po_number: '7003',
          maximo_ponum: 'PO104898',
          maximo_exists: true,
          maximo_status: 'CAN',
        }),
        // de SAP solo: sin cambio
        row({ external_key: '4', po_number: '7004' }),
      ])
      .mockResolvedValueOnce([
        // su copia en SAP ya cerró → entregada
        row({
          source: 'maximo',
          external_key: 'PO200',
          po_number: 'PO200',
          po_status: 'INPRG',
          maximo_status: 'INPRG',
        }),
        // su copia en SAP se canceló → cancelada
        row({
          source: 'maximo',
          external_key: 'PO201',
          po_number: 'PO201',
          po_status: 'APPR',
          maximo_status: 'APPR',
        }),
        // sin copia en SAP → por fecha, como hoy
        row({
          source: 'maximo',
          external_key: 'PO202',
          po_number: 'PO202',
          po_status: 'APPR',
          maximo_status: 'APPR',
        }),
        // su copia sigue abierta → se muestra la fila de SAP (D1)
        row({
          source: 'maximo',
          external_key: 'PO104896',
          po_number: 'PO104896',
          po_status: 'INPRG',
          maximo_status: 'INPRG',
        }),
      ])
      .mockResolvedValueOnce([
        copy('PO104896', { open: true }, 7001),
        copy('PO104897', { open: true }, 7002),
        copy('PO104898', { open: true }, 7003),
        copy('PO200', { closed: true }, 6200),
        copy('PO201', { cancelled: true }, 6201),
      ]);
    return h;
  }

  it('I1a: la migrada CLOSE/CAN en Maximo sale de abiertas; INPRG y la de SAP solo siguen por fecha', async () => {
    const h = seeded();
    const { data } = await h.service.findAll({ limit: 50 });
    const byPo = new Map(data.map((r) => [r.po_number, r]));
    expect(data).toHaveLength(7);
    expect(byPo.get('7001')).toMatchObject({
      delivery_status: 'retrasada',
      days_left: -16,
      closed_by: null,
      maximo_status: 'INPRG',
    });
    expect(byPo.get('7002')).toMatchObject({
      delivery_status: 'entregada',
      closed_by: 'cerrada_maximo',
    });
    expect(byPo.get('7003')).toMatchObject({
      delivery_status: 'cancelada',
      closed_by: 'cancelada_maximo',
    });
    expect(byPo.get('7004')).toMatchObject({
      delivery_status: 'retrasada',
      closed_by: null,
    });
    // la de Maximo con su copia en SAP cerrada o cancelada
    expect(byPo.get('PO200')).toMatchObject({
      delivery_status: 'entregada',
      closed_by: 'cerrada_sap',
      oc_sap: '6200',
    });
    expect(byPo.get('PO201')).toMatchObject({
      delivery_status: 'cancelada',
      closed_by: 'cancelada_sap',
    });
    expect(byPo.get('PO202')).toMatchObject({
      delivery_status: 'retrasada',
      closed_by: null,
      oc_sap: null,
    });
    // D1: la PO104896 sale una vez, con la fila de SAP
    expect(byPo.has('PO104896')).toBe(false);
  });

  it('I1a: tarjetas sin las cerradas en el otro sistema; contador y lista para depurar en SAP', async () => {
    let h = seeded();
    const stats = await h.service.getStats({});
    expect(stats.counts).toMatchObject({
      retrasada: 3,
      entregada: 2,
      cancelada: 2,
    });
    expect(stats.closed_in_maximo).toBe(2);

    h = seeded();
    const purge = await h.service.findAllForExport({
      closed_in_maximo: 'true',
    });
    expect(purge.rows.map((r) => r.po_number).sort()).toEqual(['7002', '7003']);
  });

  it('I1b: recepción COMPLETE en Maximo → entregada; PARTIAL sigue abierta', async () => {
    const h = makeHarness();
    h.prisma.$queryRaw
      .mockResolvedValueOnce([
        row({
          external_key: '1',
          po_number: '7101',
          maximo_ponum: 'PO300',
          maximo_exists: true,
          maximo_status: 'INPRG',
          receipt_status: 'COMPLETE',
        }),
        row({
          external_key: '2',
          po_number: '7102',
          maximo_ponum: 'PO301',
          maximo_exists: true,
          maximo_status: 'INPRG',
          receipt_status: 'PARTIAL',
        }),
      ])
      .mockResolvedValueOnce([
        row({
          source: 'maximo',
          external_key: 'PO302',
          po_number: 'PO302',
          po_status: 'INPRG',
          maximo_status: 'INPRG',
          receipt_status: 'COMPLETE',
        }),
      ])
      .mockResolvedValueOnce([]);
    const { data } = await h.service.findAll({ limit: 50 });
    const byPo = new Map(data.map((r) => [r.po_number, r]));
    expect(byPo.get('7101')).toMatchObject({
      delivery_status: 'entregada',
      closed_by: 'recepcion_completa',
    });
    expect(byPo.get('7102')).toMatchObject({
      delivery_status: 'retrasada',
      closed_by: null,
      receipt_status: 'PARTIAL',
    });
    expect(byPo.get('PO302')).toMatchObject({
      delivery_status: 'entregada',
      closed_by: 'recepcion_completa',
    });
  });

  /**
   * K1/K2: ABENT, SAP sola, migradas (COMPLETE, PARTIAL, CLOSE sin recepción,
   * sin recepción con un PO5 desconocido) y Maximo (COMPLETE y NONE).
   */
  function receivedSeeded() {
    const h = makeHarness();
    h.addPo({ po_number: 'PO-ABENT', expected_delivery_date: rel(30) });
    h.prisma.$queryRaw
      .mockResolvedValueOnce([
        row({
          external_key: '1',
          po_number: '7101',
          maximo_ponum: 'PO300',
          maximo_exists: true,
          maximo_status: 'INPRG',
          receipt_status: 'COMPLETE',
          integration_status: 'PROCESADO',
        }),
        row({
          external_key: '2',
          po_number: '7102',
          maximo_ponum: 'PO301',
          maximo_exists: true,
          maximo_status: 'INPRG',
          receipt_status: 'PARTIAL',
          integration_status: 'ERROR',
        }),
        row({
          external_key: '3',
          po_number: '7103',
          maximo_ponum: 'PO303',
          maximo_exists: true,
          maximo_status: 'CLOSE',
        }),
        row({ external_key: '4', po_number: '7104' }),
        row({
          external_key: '5',
          po_number: '7105',
          maximo_ponum: 'PO304',
          maximo_exists: true,
          maximo_status: 'INPRG',
          integration_status: 'RARO',
        }),
      ])
      .mockResolvedValueOnce([
        row({
          source: 'maximo',
          external_key: 'PO302',
          po_number: 'PO302',
          po_status: 'INPRG',
          maximo_status: 'INPRG',
          receipt_status: 'COMPLETE',
          integration_status: 'ACTUALIZAR',
        }),
        row({
          source: 'maximo',
          external_key: 'PO305',
          po_number: 'PO305',
          po_status: 'APPR',
          maximo_status: 'APPR',
          receipt_status: 'NONE',
        }),
      ])
      .mockResolvedValueOnce([]);
    return h;
  }

  /** Celdas del Excel de una fila, por encabezado. */
  const excelCells = (
    row: Parameters<(typeof EXPEDITING_COLUMNS)[number]['value']>[0],
  ) =>
    Object.fromEntries(EXPEDITING_COLUMNS.map((c) => [c.header, c.value(row)]));

  it('K1: received_in_maximo=true trae la migrada INPRG+COMPLETE, no la de Maximo ni la de SAP sola; closed_in_maximo no la incluye', async () => {
    let h = receivedSeeded();
    const received = await h.service.findAll({
      received_in_maximo: 'true',
      limit: 50,
    });
    expect(received.meta.total).toBe(1);
    expect(received.data[0]).toMatchObject({
      po_number: '7101',
      source: 'sap',
      delivery_status: 'entregada',
      closed_by: 'recepcion_completa',
      receipt_status: 'COMPLETE',
      integration_status: 'PROCESADO',
    });

    // la lista para depurar en SAP no cambia de significado
    h = receivedSeeded();
    const purge = await h.service.findAllForExport({
      closed_in_maximo: 'true',
    });
    expect(purge.rows.map((r) => r.po_number)).toEqual(['7103']);
  });

  it('K1: /stats trae los dos conteos y solo_pendientes baja el total', async () => {
    let h = receivedSeeded();
    const stats = await h.service.getStats({});
    expect(stats).toMatchObject({
      total: 8,
      closed_in_maximo: 1,
      received_in_maximo: 1,
    });
    expect(stats.counts.entregada).toBe(3);

    // el semáforo baja; los conteos de las dos listas no dependen del chip
    h = receivedSeeded();
    const pending = await h.service.getStats({ solo_pendientes: 'true' });
    expect(pending).toMatchObject({
      total: 5,
      closed_in_maximo: 1,
      received_in_maximo: 1,
    });
    expect(pending.counts.entregada).toBe(0);
    expect(pending.counts.cancelada).toBe(0);

    h = receivedSeeded();
    const list = await h.service.findAll({
      solo_pendientes: 'true',
      limit: 50,
    });
    expect(list.meta.total).toBe(5);
    expect(list.data.map((r) => r.po_number).sort()).toEqual([
      '7102',
      '7104',
      '7105',
      'PO-ABENT',
      'PO305',
    ]);
  });

  it('K1: faceta y filtro "recepcion"; el Excel no repite la recepción', async () => {
    let h = receivedSeeded();
    const facet = await h.service.facets({ column: 'recepcion' });
    expect(facet).toMatchObject({ type: 'text', total: 8 });
    const values = facet.type === 'text' ? facet.values : [];
    expect(Object.fromEntries(values.map((v) => [v.value, v.count]))).toEqual({
      Completa: 2,
      Parcial: 1,
      'Sin recibir': 1,
      'No disponible': 2,
      '—': 2,
    });

    h = receivedSeeded();
    const complete = await h.service.findAll({
      filters: JSON.stringify({ recepcion: { in: ['Completa'] } }),
      limit: 50,
    });
    expect(complete.data.map((r) => r.po_number).sort()).toEqual([
      '7101',
      'PO302',
    ]);

    h = receivedSeeded();
    const { rows } = await h.service.findAllForExport({});
    const cells = (po: string) =>
      excelCells(rows.find((r) => r.po_number === po)!);
    expect(cells('7101')).toMatchObject({
      'Estatus en Maximo': 'INPRG',
      'Recepción en Maximo': 'Completa',
      Cierre: 'Recepción completa en Maximo',
    });
    // PARCIAL: la recepción sale una vez, en su columna
    const partial = cells('7102');
    expect(partial).toMatchObject({
      'Estatus en Maximo': 'INPRG',
      'Recepción en Maximo': 'Parcial',
    });
    expect(
      Object.entries(partial)
        .filter(([, v]) => typeof v === 'string' && /recep|parcial/i.test(v))
        .map(([header]) => header),
    ).toEqual(['Recepción en Maximo']);
    expect(cells('7104')['Recepción en Maximo']).toBe('—');
    expect(cells('7105')['Recepción en Maximo']).toBe('No disponible');
    expect(cells('PO-ABENT')['Recepción en Maximo']).toBe('—');
  });

  it('K2: faceta y filtro "integracion"; el Excel trae la columna de PO5 y rotula el monto con IVA', async () => {
    let h = receivedSeeded();
    const facet = await h.service.facets({ column: 'integracion' });
    const values = facet.type === 'text' ? facet.values : [];
    expect(Object.fromEntries(values.map((v) => [v.value, v.count]))).toEqual({
      Procesado: 1,
      Error: 1,
      Actualizar: 1,
      RARO: 1,
      'Sin dato': 2,
      '—': 2,
    });

    h = receivedSeeded();
    const errors = await h.service.findAll({
      filters: JSON.stringify({ integracion: { in: ['Error'] } }),
    });
    expect(errors.data.map((r) => r.po_number)).toEqual(['7102']);

    h = receivedSeeded();
    const { rows } = await h.service.findAllForExport({});
    const headers = EXPEDITING_COLUMNS.map((c) => c.header);
    // junto a "Estatus en Maximo"
    expect(headers.indexOf('Integración SAP (PO5)')).toBe(
      headers.indexOf('Estatus en Maximo') + 1,
    );
    expect(
      Object.fromEntries(
        rows.map((r) => [r.po_number, excelCells(r)['Integración SAP (PO5)']]),
      ),
    ).toEqual({
      '7101': 'Procesado',
      '7102': 'Error',
      '7103': 'Sin dato',
      '7104': '—',
      '7105': 'RARO',
      PO302: 'Actualizar',
      PO305: 'Sin dato',
      'PO-ABENT': '—',
    });
    // K6.9: los montos por fila se quedan con IVA y el encabezado lo dice
    expect(headers).toContain('Monto (con IVA en SAP y Maximo)');
  });

  it('H16: las dos consultas piden la recepción y la integración (PO5) de Maximo (los mocks no prueban el SQL)', async () => {
    const h = receivedSeeded();
    // sin `source`: las tres consultas, en orden (SAP, Maximo, copias en SAP)
    await h.service.findAll({});
    const calls = h.prisma.$queryRaw.mock.calls as unknown[][];
    const sqlOf = (i: number) =>
      (calls[i][0] as { sql: string }).sql.replace(/\s+/g, ' ');
    const sapSql = sqlOf(0);
    const mxSql = sqlOf(1);
    expect(sapSql).toContain('FROM sap_purchase_orders s');
    // SELECT de la OC de SAP y el LATERAL de su PO de Maximo
    expect(sapSql).toMatch(/mx\.receipt_status, mx\.integration_status/);
    expect(sapSql).toMatch(
      /m\.status, m\.receipt_status, m\.integration_status FROM maximo_purchase_orders m/,
    );
    expect(sapSql).toContain('mx.status AS maximo_status');
    // la PO de Maximo (sin copia en SAP)
    expect(mxSql).toContain("SELECT 'maximo'::text AS source");
    expect(mxSql).toMatch(/\breceipt_status, integration_status FROM current/);
  });

  it('I2: las dos columnas (PO Maximo / OC SAP) y la búsqueda por PONUM con o sin "PO"', async () => {
    let h = seeded();
    const { data } = await h.service.findAll({ limit: 50 });
    const byPo = new Map(data.map((r) => [r.po_number, r]));
    expect(byPo.get('7001')).toMatchObject({
      po_maximo: 'PO104896',
      oc_sap: '7001',
    });
    expect(byPo.get('7004')).toMatchObject({ po_maximo: null, oc_sap: '7004' });
    expect(byPo.get('PO202')).toMatchObject({
      po_maximo: 'PO202',
      oc_sap: null,
    });

    for (const search of ['104896', 'PO104896', 'po 104896']) {
      h = seeded();
      await h.service.findAll({ search });
      // el término llega a SQL también como número (sin espacios ni "PO")
      const calls = h.prisma.$queryRaw.mock.calls as unknown[][];
      const sql = calls[0][0] as { values: unknown[] };
      expect(sql.values).toContain('%104896%');
    }

    // la de Maximo se encuentra por su número y por el de su OC de SAP
    h = seeded();
    const maximoOnly = await h.service.findAll({
      search: '202',
      source: 'maximo',
    });
    expect(maximoOnly.data.map((r) => r.po_number)).toEqual(['PO202']);
    h = seeded();
    const bySapDoc = await h.service.findAll({
      search: '6200',
      source: 'maximo',
    });
    expect(bySapDoc.data.map((r) => r.po_number)).toEqual(['PO200']);
  });

  it('I2: filtro tipo Excel por las columnas nuevas', async () => {
    let h = seeded();
    const filtered = await h.service.findAll({
      filters: JSON.stringify({ po_maximo: { in: ['PO104897'] } }),
    });
    expect(filtered.data.map((r) => r.po_number)).toEqual(['7002']);
    h = seeded();
    const closure = await h.service.findAll({
      filters: JSON.stringify({ cierre: { in: ['Cerrada en Maximo'] } }),
    });
    expect(closure.data.map((r) => r.po_number)).toEqual(['7002']);
  });
});

describe('poSearchNumber (I2)', () => {
  it('quita espacios y el prefijo "PO"; un texto no numérico no es número', () => {
    expect(poSearchNumber('104896')).toBe('104896');
    expect(poSearchNumber('PO104896')).toBe('104896');
    expect(poSearchNumber('po 104896')).toBe('104896');
    expect(poSearchNumber(' Po104896 ')).toBe('104896');
    expect(poSearchNumber('NAES')).toBeNull();
    expect(poSearchNumber('PO-104896')).toBeNull();
    expect(poSearchNumber(undefined)).toBeNull();
  });
});
