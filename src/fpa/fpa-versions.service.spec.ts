import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { FpaVersionsService } from './fpa-versions.service';
import { FpaService } from './fpa.service';
import type { FpaVersionParamsDto } from './dto/fpa-version.dto';

/**
 * FP&A (B2) — versiones y parámetros con el visto bueno de planeación, con
 * Prisma EN MEMORIA (cero red, cero BD). Lo que se prueba es la regla del
 * 26-oct: Laura carga los parámetros en preparación, David da el visto bueno
 * (nunca quien hizo el último cambio), abrir lo exige, abierta no cambian y
 * solo regresa a preparación mientras nadie haya enviado (el candado).
 */

const D = (v: string | number) => new Prisma.Decimal(v);

const asUser = (id: string, roles: string[]): AuthUser =>
  ({
    id,
    email: `${id}@abent3t.com`,
    full_name: id,
    role: roles[0],
    roles,
    role_assignments: roles.map((role) => ({ module: 'fpa', role })),
    department_id: null,
    is_active: true,
  }) as AuthUser;

const LAURA = asUser('laura', ['fpa_planeacion']);
const LILIANA = asUser('liliana', ['fpa_planeacion']);
const DAVID = asUser('david', ['fpa_planeacion']);
const URIEL = asUser('uriel', ['fpa_cfo']);
const DIANA = asUser('diana', ['fpa_area']);
const ALEX = asUser('alex', ['super_admin']);
/** super_admin que además tiene planeación (soporte que también es de FP&A). */
const SOPORTE_PLAN = asUser('soporte', ['super_admin', 'fpa_planeacion']);

interface Row {
  id: string;
  [k: string]: unknown;
}

const TARIFAS_B26 = [
  ['nacional', 'colaborador', 4000, 2500, 500, 1000],
  ['nacional', 'director', 9000, 2500, 500, 2000],
  ['internacional', 'colaborador', 20000, 3500, 1000, 1500],
  ['internacional', 'director', 40000, 3500, 1000, 2500],
] as const;

const TRAVEL_INPUT = TARIFAS_B26.map(
  ([trip_type, traveler_type, f, h, t, m]) => ({
    trip_type,
    traveler_type,
    flight_per_person: String(f),
    hotel_per_night: String(h),
    transport_per_day: String(t),
    meals_per_day: String(m),
  }),
);

let seq = 0;
const newId = () => `id-${++seq}`;

/** Base en memoria con lo que hay en prod desde el 27-oct, más una B-27 nueva. */
function makeStore(opts: { signer?: 'david' | null } = {}) {
  const versions: Row[] = [
    {
      id: 'b26',
      code: 'B-26',
      name: 'Presupuesto 2026',
      fiscal_year: 2026,
      kind: 'presupuesto',
      status: 'captura',
      cutoff_month: null,
      base_version_id: null,
      inflation_pct: D('4.000'),
      notes: 'arranque',
      is_active: true,
      created_at: new Date('2026-10-27T18:00:00Z'),
      params_source: null,
      params_updated_by: null,
      params_updated_at: null,
      params_approved_by: null,
      params_approved_at: null,
    },
    {
      id: 'b27',
      code: 'B-27',
      name: 'Presupuesto 2027',
      fiscal_year: 2027,
      kind: 'presupuesto',
      status: 'preparacion',
      cutoff_month: null,
      base_version_id: null,
      inflation_pct: null,
      notes: null,
      is_active: true,
      created_at: new Date('2026-10-28T15:00:00Z'),
      params_source: null,
      params_updated_by: null,
      params_updated_at: null,
      params_approved_by: null,
      params_approved_at: null,
    },
  ];
  const rates: Row[] = [
    {
      id: 'r1',
      version_id: 'b26',
      currency: 'USD',
      rate_mxn: D('20'),
      is_active: true,
    },
    {
      id: 'r2',
      version_id: 'b26',
      currency: 'EUR',
      rate_mxn: D('22'),
      is_active: true,
    },
  ];
  const travel: Row[] = TARIFAS_B26.map(
    ([trip_type, traveler_type, f, h, t, m], i) => ({
      id: `t${i}`,
      version_id: 'b26',
      trip_type,
      traveler_type,
      flight_per_person: D(f),
      hotel_per_night: D(h),
      transport_per_day: D(t),
      meals_per_day: D(m),
      is_active: true,
    }),
  );
  const areas: Row[] = [
    { id: 'compras', name: 'Compras', is_active: true },
    { id: 'planta', name: 'Planta', is_active: true },
    { id: 'legal', name: 'Legal', is_active: false },
  ];
  const budgets: Row[] = [
    {
      id: 'bud-compras',
      version_id: 'b26',
      area_id: 'compras',
      status: 'borrador',
      current_round: 0,
      is_active: true,
    },
    {
      id: 'bud-planta',
      version_id: 'b26',
      area_id: 'planta',
      status: 'borrador',
      current_round: 0,
      is_active: true,
    },
  ];
  const lines: Row[] = [
    {
      id: 'l1',
      version_id: 'b26',
      budget_id: 'bud-compras',
      currency: 'MXN',
      is_active: true,
    },
    {
      id: 'l2',
      version_id: 'b26',
      budget_id: 'bud-planta',
      currency: 'USD',
      is_active: true,
    },
  ];
  const assignments: Row[] =
    opts.signer === 'david'
      ? [
          {
            id: 'as-david',
            duty: 'planeacion',
            area_id: null,
            profile_id: 'david',
            is_alternate: false,
            is_active: true,
            created_at: new Date(),
          },
        ]
      : [];
  const profiles: Row[] = [
    'laura',
    'liliana',
    'david',
    'uriel',
    'diana',
    'alex',
  ].map((id) => ({
    id,
    full_name:
      id === 'david'
        ? 'David Rodríguez'
        : id.charAt(0).toUpperCase() + id.slice(1),
    email: `${id}@abent3t.com`,
  }));
  const events: Row[] = [];
  return {
    versions,
    rates,
    travel,
    areas,
    budgets,
    lines,
    assignments,
    profiles,
    events,
  };
}

type Store = ReturnType<typeof makeStore>;

/** Relaciones que puede filtrar un where (p. ej. fpa_budgets: { is_active }). */
type Relations = Record<string, (row: Row) => Row | undefined>;

const matches = (
  row: Row,
  where: Record<string, unknown> = {},
  relations: Relations = {},
): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k in relations) {
      const related = relations[k](row);
      return !!related && matches(related, v as Record<string, unknown>);
    }
    if (
      v &&
      typeof v === 'object' &&
      !(v instanceof Date) &&
      !Array.isArray(v)
    ) {
      const cond = v as Record<string, unknown>;
      if ('in' in cond) return (cond.in as unknown[]).includes(row[k]);
      if ('equals' in cond) {
        return (
          String(row[k]).toLowerCase() === String(cond.equals).toLowerCase()
        );
      }
      // Que un filtro nuevo no pase en silencio
      throw new Error(`El fake no sabe filtrar por ${k}`);
    }
    return row[k] === v;
  });

const pick = (row: Row, select?: Record<string, boolean>) =>
  select
    ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]))
    : { ...row };

/** Prisma en memoria: solo lo que usan FpaVersionsService y los firmantes. */
function fakePrisma(store: Store) {
  // Los parámetros salen con el where de su include, como en Prisma (si el
  // service dejara de pedir solo los activos, las pruebas lo verían)
  const withParams = (v: Row, include: Record<string, unknown>) => {
    const sub = (key: string) =>
      (include[key] as { where?: Record<string, unknown> } | undefined)?.where;
    return {
      ...v,
      fpa_exchange_rates: store.rates
        .filter(
          (r) => r.version_id === v.id && matches(r, sub('fpa_exchange_rates')),
        )
        .sort((a, b) => String(a.currency).localeCompare(String(b.currency))),
      fpa_travel_rates: store.travel.filter(
        (t) => t.version_id === v.id && matches(t, sub('fpa_travel_rates')),
      ),
    };
  };
  // defaults: lo que pone la base al insertar (p. ej. un presupuesto nace en borrador)
  const table = (
    rows: Row[],
    relations: Relations = {},
    defaults: Record<string, unknown> = {},
  ) => ({
    findMany: jest.fn(
      ({
        where,
        select,
      }: {
        where?: Record<string, unknown>;
        select?: Record<string, boolean>;
      } = {}) =>
        Promise.resolve(
          rows
            .filter((r) => matches(r, where, relations))
            .map((r) => pick(r, select)),
        ),
    ),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const row = { id: newId(), is_active: true, ...defaults, ...data } as Row;
      rows.push(row);
      return Promise.resolve(row);
    }),
    createMany: jest.fn(({ data }: { data: Record<string, unknown>[] }) => {
      for (const d of data)
        rows.push({ id: newId(), is_active: true, ...defaults, ...d } as Row);
      return Promise.resolve({ count: data.length });
    }),
    update: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error(`no existe ${where.id}`);
        Object.assign(row, data);
        return Promise.resolve(row);
      },
    ),
  });
  const prisma = {
    fpa_versions: {
      ...table(store.versions),
      findFirst: jest.fn(
        ({
          where,
          include,
          select,
        }: {
          where: Record<string, unknown>;
          include?: unknown;
          select?: Record<string, boolean>;
        }) => {
          const v = store.versions.find((r) => matches(r, where));
          if (!v) return Promise.resolve(null);
          return Promise.resolve(
            include
              ? withParams(v, include as Record<string, unknown>)
              : pick(v, select),
          );
        },
      ),
      findUnique: jest.fn(
        ({
          where,
          select,
        }: {
          where: { id: string };
          select?: Record<string, boolean>;
        }) => {
          const v = store.versions.find((r) => r.id === where.id);
          return Promise.resolve(v ? pick(v, select) : null);
        },
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: newId(),
          is_active: true,
          base_version_id: null,
          notes: null,
          created_at: new Date(),
          params_approved_by: null,
          params_approved_at: null,
          ...data,
          inflation_pct:
            data.inflation_pct === null || data.inflation_pct === undefined
              ? null
              : D(data.inflation_pct as string),
        } as Row;
        store.versions.push(row);
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
          const row = store.versions.find((r) => r.id === where.id) as Row;
          Object.assign(row, data);
          if ('inflation_pct' in data) {
            row.inflation_pct =
              data.inflation_pct === null
                ? null
                : D(data.inflation_pct as string);
          }
          return Promise.resolve(row);
        },
      ),
    },
    fpa_exchange_rates: {
      ...table(store.rates),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: newId(),
          is_active: true,
          ...data,
          rate_mxn: D(String(data.rate_mxn)),
        } as Row;
        store.rates.push(row);
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
          const row = store.rates.find((r) => r.id === where.id) as Row;
          Object.assign(row, data);
          if ('rate_mxn' in data) row.rate_mxn = D(String(data.rate_mxn));
          return Promise.resolve(row);
        },
      ),
    },
    fpa_travel_rates: {
      ...table(store.travel),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: newId(), is_active: true, ...data } as Row;
        for (const k of [
          'flight_per_person',
          'hotel_per_night',
          'transport_per_day',
          'meals_per_day',
        ]) {
          row[k] = D(String(data[k]));
        }
        store.travel.push(row);
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
          const row = store.travel.find((r) => r.id === where.id) as Row;
          Object.assign(row, data);
          for (const k of [
            'flight_per_person',
            'hotel_per_night',
            'transport_per_day',
            'meals_per_day',
          ]) {
            if (k in data) row[k] = D(String(data[k]));
          }
          return Promise.resolve(row);
        },
      ),
    },
    fpa_budgets: table(
      store.budgets,
      {},
      { status: 'borrador', current_round: 0 },
    ),
    fpa_budget_lines: table(store.lines, {
      fpa_budgets: (l) => store.budgets.find((b) => b.id === l.budget_id),
    }),
    fpa_areas: table(store.areas),
    fpa_assignments: {
      ...table(store.assignments),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          store.assignments
            .filter((a) => {
              const duty = where.duty as string | { in: string[] } | undefined;
              if (typeof duty === 'string' && a.duty !== duty) return false;
              if (
                duty &&
                typeof duty === 'object' &&
                !duty.in.includes(a.duty as string)
              )
                return false;
              if ('area_id' in where && a.area_id !== where.area_id)
                return false;
              return a.is_active === true;
            })
            .map((a) => ({
              ...a,
              profiles_fpa_assignments_profile_idToprofiles:
                store.profiles.find((p) => p.id === a.profile_id),
            })),
        ),
      ),
    },
    fpa_version_events: {
      ...table(store.events),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: newId(), created_at: new Date(), ...data } as Row;
        store.events.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn(({ where }: { where: { version_id: string } }) =>
        Promise.resolve(
          store.events
            .filter((e) => e.version_id === where.version_id)
            .reverse()
            .map((e) => ({
              ...e,
              profiles: store.profiles.find((p) => p.id === e.actor_profile_id),
            })),
        ),
      ),
    },
    profiles: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          store.profiles.filter((p) => where.id.in.includes(p.id)),
        ),
      ),
      findFirst: jest.fn(({ where }: { where: { id: string } }) => {
        // Firmantes: david, laura y liliana tienen fpa_planeacion; uriel, fpa_cfo
        const roles: Record<string, string> = {
          david: 'fpa_planeacion',
          laura: 'fpa_planeacion',
          liliana: 'fpa_planeacion',
          uriel: 'fpa_cfo',
          diana: 'fpa_area',
        };
        const wanted = (
          where as {
            user_roles_user_roles_profile_idToprofiles?: {
              some: { role: string };
            };
          }
        ).user_roles_user_roles_profile_idToprofiles?.some.role;
        const ok = roles[where.id] && (!wanted || roles[where.id] === wanted);
        return Promise.resolve(ok ? { id: where.id } : null);
      }),
    },
    $queryRaw: jest.fn<
      Promise<unknown[]>,
      [TemplateStringsArray, ...unknown[]]
    >(() => Promise.resolve([])),
  };
  return Object.assign(prisma, {
    $transaction: jest.fn((fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    ),
  });
}

function setup(opts: { signer?: 'david' | null } = {}) {
  const store = makeStore(opts);
  const prisma = fakePrisma(store);
  const service = new FpaVersionsService(prisma as unknown as PrismaService);
  return { store, prisma, service };
}

const lastEvent = (store: Store) => store.events[store.events.length - 1];

/** Parámetros completos para la B-27 (los de la B-26 con 3.7% y USD 19.5). */
const PARAMS_B27: FpaVersionParamsDto = {
  inflation_pct: '3.7',
  params_source: 'Proyecciones Santander, sep-2026',
  exchange_rates: [{ currency: 'USD', rate_mxn: '19.5' }],
  travel_rates: TRAVEL_INPUT,
};

describe('FpaVersionsService — detalle y quién ve qué', () => {
  it('planeación ve los parámetros, su hash y lo que puede hacer', async () => {
    const { service } = setup();
    const d = await service.detail(LILIANA, 'b26');
    expect(d.version).toMatchObject({ code: 'B-26', status: 'captura' });
    expect(d.params.inflation_pct).toBe('4.000');
    expect(d.params.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(d.gaps).toEqual([]);
    expect(d.params_approved).toBeNull();
    expect(d.signers.rule).toBe('rol');
    // La B-26 de prod: abierta, sin visto bueno y sin envíos
    expect(d.actions.approve.ok).toBe(true);
    expect(d.actions.edit_params).toMatchObject({ ok: false });
    expect(d.actions.edit_params.reason).toMatch(/regrésala a preparación/);
    expect(d.actions.give_back.ok).toBe(true);
    expect(d.actions.open.ok).toBe(false);
  });

  it('el CFO ve el detalle, pero no cambia nada', async () => {
    const { service } = setup();
    const d = await service.detail(URIEL, 'b26');
    expect(d.actions.approve).toEqual({
      ok: false,
      reason: 'Solo planeación da el visto bueno',
    });
    expect(d.actions.give_back.ok).toBe(false);
    await expect(
      service.setParams(URIEL, 'b27', PARAMS_B27),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un área no ve las versiones por esta vía (403)', async () => {
    const { service } = setup();
    await expect(service.detail(DIANA, 'b26')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('FpaVersionsService — alta de versión', () => {
  it('B-27 en preparación con los parámetros de la B-26: quedan como cambio de quien la creó', async () => {
    const { service, store } = setup();
    const d = await service.create(LAURA, {
      code: 'P-27',
      name: 'Prueba 2027',
      fiscal_year: 2027,
      kind: 'presupuesto',
      copy_params_from: 'b26',
    });
    expect(d.version).toMatchObject({ code: 'P-27', status: 'preparacion' });
    expect(d.params.inflation_pct).toBe('4.000');
    expect(d.params.exchange_rates.map((r) => r.currency)).toEqual([
      'EUR',
      'USD',
    ]);
    expect(d.params.travel_rates).toHaveLength(4);
    expect(d.params_updated?.by?.id).toBe('laura');
    expect(d.params_approved).toBeNull();
    expect(lastEvent(store)).toMatchObject({
      action: 'creada',
      to_status: 'preparacion',
      detail: { schema: 1, copia_de: { id: 'b26', code: 'B-26' } },
      acting_as: 'rol',
      actor_role: 'fpa_planeacion',
    });
    // La B-26 no se tocó
    expect(store.rates.filter((r) => r.version_id === 'b26')).toHaveLength(2);
  });

  it('una moneda dada de baja en la B-26 no se copia a la nueva', async () => {
    const { service, store } = setup();
    (store.rates.find((r) => r.id === 'r2') as Row).is_active = false;
    const d = await service.create(LAURA, {
      code: 'B-28',
      name: 'Presupuesto 2028',
      fiscal_year: 2028,
      kind: 'presupuesto',
      cutoff_month: null,
      copy_params_from: 'b26',
    });
    expect(d.params.exchange_rates.map((r) => r.currency)).toEqual(['USD']);
  });

  it('la clave no se repite, sin importar mayúsculas (409)', async () => {
    const { service } = setup();
    await expect(
      service.create(LAURA, {
        code: 'b-26',
        name: 'Otra',
        fiscal_year: 2026,
        kind: 'presupuesto',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('solo un forecast lleva mes de corte, y siempre lo lleva (400)', async () => {
    const { service } = setup();
    await expect(
      service.create(LAURA, {
        code: 'F1-26',
        name: 'Forecast 1',
        fiscal_year: 2026,
        kind: 'forecast',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(LAURA, {
        code: 'X-26',
        name: 'X',
        fiscal_year: 2026,
        kind: 'presupuesto',
        cutoff_month: 4,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el CFO no da de alta versiones (403)', async () => {
    const { service } = setup();
    await expect(
      service.create(URIEL, {
        code: 'B-28',
        name: 'B',
        fiscal_year: 2028,
        kind: 'presupuesto',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('FpaVersionsService — parámetros', () => {
  it('Laura los carga en preparación: quedan su nombre, la hora y el antes y el después', async () => {
    const { service, store } = setup();
    const d = await service.setParams(LAURA, 'b27', PARAMS_B27);
    expect(d.params).toMatchObject({
      inflation_pct: '3.700',
      source: 'Proyecciones Santander, sep-2026',
    });
    expect(d.params.exchange_rates).toEqual([
      { currency: 'USD', rate_mxn: '19.500000' },
    ]);
    expect(d.gaps).toEqual([]);
    expect(d.params_updated?.by?.id).toBe('laura');
    const ev = lastEvent(store);
    expect(ev.action).toBe('parametros');
    const detail = ev.detail as {
      cambios: Array<{ campo: string }>;
      visto_bueno_retirado: unknown;
    };
    expect(detail.cambios.map((c) => c.campo)).toEqual(
      expect.arrayContaining([
        'inflation_pct',
        'source',
        'rate:USD',
        'travel:nacional:director:meals_per_day',
      ]),
    );
    expect(detail.visto_bueno_retirado).toBeNull();
  });

  it('si nada cambió, no hace nada y el visto bueno se queda', async () => {
    const { service, store } = setup();
    await service.setParams(LAURA, 'b27', PARAMS_B27);
    const v = store.versions.find((x) => x.id === 'b27') as Row;
    Object.assign(v, {
      params_approved_by: 'david',
      params_approved_at: new Date(),
    });
    const events = store.events.length;
    const d = await service.setParams(LAURA, 'b27', PARAMS_B27);
    expect(store.events).toHaveLength(events);
    expect(d.params_approved?.by?.id).toBe('david');
  });

  it('un cambio quita el visto bueno y lo deja dicho en el historial', async () => {
    const { service, store } = setup();
    await service.setParams(LAURA, 'b27', PARAMS_B27);
    const v = store.versions.find((x) => x.id === 'b27') as Row;
    Object.assign(v, {
      params_approved_by: 'david',
      params_approved_at: new Date('2026-10-28T17:00:00Z'),
    });
    const d = await service.setParams(LAURA, 'b27', {
      ...PARAMS_B27,
      inflation_pct: '3.9',
    });
    expect(d.params_approved).toBeNull();
    expect(v.params_approved_by).toBeNull();
    expect(
      (lastEvent(store).detail as { visto_bueno_retirado: unknown })
        .visto_bueno_retirado,
    ).toEqual({
      por: 'david',
      el: '2026-10-28T17:00:00.000Z',
    });
  });

  it('la moneda que se quita queda de baja y la que regresa se reactiva', async () => {
    const { service, store } = setup();
    // La B-26 regresa a preparación para probar con sus filas
    (store.versions.find((x) => x.id === 'b26') as Row).status = 'preparacion';
    await service.setParams(LAURA, 'b26', {
      exchange_rates: [{ currency: 'USD', rate_mxn: '20' }],
      travel_rates: TRAVEL_INPUT,
    });
    expect(store.rates.find((r) => r.id === 'r2')?.is_active).toBe(false);
    await service.setParams(LAURA, 'b26', {
      exchange_rates: [
        { currency: 'USD', rate_mxn: '20' },
        { currency: 'EUR', rate_mxn: '21.5' },
      ],
      travel_rates: TRAVEL_INPUT,
    });
    const eur = store.rates.filter(
      (r) => r.version_id === 'b26' && r.currency === 'EUR',
    );
    expect(eur).toHaveLength(1);
    expect(eur[0]).toMatchObject({ is_active: true });
    expect((eur[0].rate_mxn as Prisma.Decimal).toFixed(2)).toBe('21.50');
  });

  it('abierta a captura o cerrada, los parámetros no cambian (409)', async () => {
    const { service, store } = setup();
    await expect(service.setParams(LAURA, 'b26', PARAMS_B27)).rejects.toThrow(
      /regrésala a preparación/,
    );
    (store.versions.find((x) => x.id === 'b26') as Row).status = 'cerrada';
    await expect(
      service.setParams(LAURA, 'b26', PARAMS_B27),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('con una pantalla vieja (otro hash) no pisa lo de otra persona (409)', async () => {
    const { service } = setup();
    await expect(
      service.setParams(LAURA, 'b27', {
        ...PARAMS_B27,
        expected_hash: '0000000000000000',
      }),
    ).rejects.toThrow(/Otra persona cambió los parámetros/);
  });

  it('pesos, monedas o tarifas repetidas no pasan (400)', async () => {
    const { service } = setup();
    await expect(
      service.setParams(LAURA, 'b27', {
        ...PARAMS_B27,
        exchange_rates: [{ currency: 'MXN', rate_mxn: '1' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.setParams(LAURA, 'b27', {
        ...PARAMS_B27,
        exchange_rates: [
          { currency: 'USD', rate_mxn: '19' },
          { currency: 'USD', rate_mxn: '20' },
        ],
      }),
    ).rejects.toThrow(/viene dos veces/);
    await expect(
      service.setParams(LAURA, 'b27', {
        ...PARAMS_B27,
        travel_rates: [TRAVEL_INPUT[0], TRAVEL_INPUT[0]],
      }),
    ).rejects.toThrow(/viene dos veces/);
    await expect(
      service.setParams(LAURA, 'b27', {
        ...PARAMS_B27,
        exchange_rates: [{ currency: 'USD', rate_mxn: '0' }],
      }),
    ).rejects.toThrow(/mayor a 0/);
  });
});

describe('FpaVersionsService — visto bueno', () => {
  async function b27WithParams() {
    const ctx = setup();
    await ctx.service.setParams(LAURA, 'b27', PARAMS_B27);
    const hash = (await ctx.service.detail(LAURA, 'b27')).params.hash;
    return { ...ctx, hash };
  }

  it('sin firmantes registrados, otra persona de planeación lo da (por rol) y queda la foto', async () => {
    const { service, store, hash } = await b27WithParams();
    const d = await service.approve(LILIANA, 'b27', { params_hash: hash });
    expect(d.params_approved?.by?.id).toBe('liliana');
    const ev = lastEvent(store);
    expect(ev).toMatchObject({
      action: 'visto_bueno',
      acting_as: 'rol',
      actor_role: 'fpa_planeacion',
    });
    expect(
      (ev.detail as { hash: string; parametros: { inflation_pct: string } })
        .parametros.inflation_pct,
    ).toBe('3.700');
    expect((ev.detail as { hash: string }).hash).toBe(hash);
  });

  it('quien hizo el último cambio no se da el visto bueno (403)', async () => {
    const { service, hash } = await b27WithParams();
    const attempt = service.approve(LAURA, 'b27', { params_hash: hash });
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    await expect(attempt).rejects.toThrow(/Tú hiciste el último cambio/);
  });

  it('con David como firmante, solo él lo da; Liliana no (403)', async () => {
    const ctx = setup({ signer: 'david' });
    await ctx.service.setParams(LAURA, 'b27', PARAMS_B27);
    const hash = (await ctx.service.detail(LAURA, 'b27')).params.hash;
    expect((await ctx.service.detail(LILIANA, 'b27')).signers).toMatchObject({
      rule: 'registrados',
      titular: { id: 'david', full_name: 'David Rodríguez' },
    });
    const attempt = ctx.service.approve(LILIANA, 'b27', { params_hash: hash });
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    await expect(attempt).rejects.toThrow(
      /firmante de planeación: David Rodríguez/,
    );
    const d = await ctx.service.approve(DAVID, 'b27', { params_hash: hash });
    expect(d.params_approved?.by?.full_name).toBe('David Rodríguez');
    expect(lastEvent(ctx.store).acting_as).toBe('titular');
  });

  it('soporte con rol de planeación queda como super_admin, no como planeación', async () => {
    const ctx = setup({ signer: 'david' });
    await ctx.service.setParams(LAURA, 'b27', PARAMS_B27);
    const hash = (await ctx.service.detail(LAURA, 'b27')).params.hash;
    await ctx.service.approve(SOPORTE_PLAN, 'b27', { params_hash: hash });
    expect(lastEvent(ctx.store)).toMatchObject({
      action: 'visto_bueno',
      acting_as: 'super_admin',
      actor_role: 'super_admin',
    });
  });

  it('super_admin puede darlo como soporte, y queda dicho', async () => {
    const ctx = setup({ signer: 'david' });
    await ctx.service.setParams(LAURA, 'b27', PARAMS_B27);
    const hash = (await ctx.service.detail(LAURA, 'b27')).params.hash;
    await ctx.service.approve(ALEX, 'b27', { params_hash: hash });
    expect(lastEvent(ctx.store)).toMatchObject({
      acting_as: 'super_admin',
      actor_role: 'super_admin',
    });
  });

  it('si los parámetros cambiaron mientras los revisaba, no aprueba lo que no vio (409)', async () => {
    const { service } = await b27WithParams();
    await expect(
      service.approve(LILIANA, 'b27', { params_hash: 'ffffffffffffffff' }),
    ).rejects.toThrow(/cambiaron mientras los revisabas/);
  });

  it('una vez dado, no se vuelve a dar; con faltantes, tampoco (409)', async () => {
    const { service, hash } = await b27WithParams();
    await service.approve(LILIANA, 'b27', { params_hash: hash });
    await expect(
      service.approve(DAVID, 'b27', { params_hash: hash }),
    ).rejects.toBeInstanceOf(ConflictException);
    const fresh = setup();
    const h = (await fresh.service.detail(LAURA, 'b27')).params.hash;
    await expect(
      fresh.service.approve(LILIANA, 'b27', { params_hash: h }),
    ).rejects.toThrow(/Falta la inflación/);
  });

  it('la B-26 que ya estaba abierta puede recibir su visto bueno sin cerrarse', async () => {
    const { service } = setup();
    const hash = (await service.detail(LAURA, 'b26')).params.hash;
    const d = await service.approve(LAURA, 'b26', { params_hash: hash });
    expect(d.version.status).toBe('captura');
    expect(d.params_approved?.by?.id).toBe('laura');
  });
});

describe('FpaVersionsService — abrir, regresar, cerrar y reabrir', () => {
  it('abrir exige el visto bueno (409)', async () => {
    const { service } = setup();
    await service.setParams(LAURA, 'b27', PARAMS_B27);
    await expect(service.open(LAURA, 'b27')).rejects.toThrow(
      /Falta el visto bueno/,
    );
  });

  it('abrir exige los parámetros completos (409)', async () => {
    const { service } = setup();
    await expect(service.open(LAURA, 'b27')).rejects.toThrow(
      /Faltan parámetros: Falta la inflación/,
    );
  });

  it('con visto bueno, abre y crea el presupuesto en borrador de cada área activa', async () => {
    const { service, store } = setup();
    await service.setParams(LAURA, 'b27', PARAMS_B27);
    const hash = (await service.detail(LAURA, 'b27')).params.hash;
    await service.approve(LILIANA, 'b27', { params_hash: hash });
    const d = await service.open(LAURA, 'b27');
    expect(d.version.status).toBe('captura');
    const created = store.budgets.filter((b) => b.version_id === 'b27');
    expect(created.map((b) => b.area_id).sort()).toEqual(['compras', 'planta']);
    expect(lastEvent(store)).toMatchObject({
      action: 'abierta',
      from_status: 'preparacion',
      to_status: 'captura',
      detail: { schema: 1, presupuestos_creados: 2 },
    });
    await expect(service.open(LAURA, 'b27')).rejects.toThrow(/ya está abierta/);
  });

  it('una versión de comparación no se abre (409)', async () => {
    const { service, store } = setup();
    Object.assign(store.versions.find((x) => x.id === 'b27') as Row, {
      kind: 'comparacion',
    });
    await expect(service.open(LAURA, 'b27')).rejects.toThrow(
      /comparación no se abre/,
    );
  });

  it('regresa a preparación mientras nadie haya enviado', async () => {
    const { service, store } = setup();
    const d = await service.giveBack(LAURA, 'b26', 'Ajustar el tipo de cambio');
    expect(d.version.status).toBe('preparacion');
    expect(d.actions.edit_params.ok).toBe(true);
    expect(lastEvent(store)).toMatchObject({
      action: 'regresada',
      from_status: 'captura',
      to_status: 'preparacion',
      comment: 'Ajustar el tipo de cambio',
    });
  });

  it('el candado: con un presupuesto que ya se envió una vez, ya no regresa (409)', async () => {
    const { service, store } = setup();
    Object.assign(store.budgets[0], { status: 'devuelto', current_round: 1 });
    await expect(service.giveBack(LAURA, 'b26', null)).rejects.toThrow(
      /ya hay presupuestos enviados/i,
    );
  });

  it('no se cierra con presupuestos en aprobación; sin ellos, sí', async () => {
    const { service, store } = setup();
    Object.assign(store.budgets[1], { status: 'enviado', current_round: 1 });
    await expect(service.close(LAURA, 'b26', null)).rejects.toThrow(
      /en aprobación/,
    );
    Object.assign(store.budgets[1], { status: 'aprobado_cfo' });
    const d = await service.close(LAURA, 'b26', 'Presupuesto 2026 cerrado');
    expect(d.version.status).toBe('cerrada');
    expect(d.actions.edit_info.ok).toBe(false);
  });

  it('reabrir pide comentario y solo aplica a una cerrada', async () => {
    const { service, store } = setup();
    await expect(
      service.reopen(LAURA, 'b26', 'Se cerró por error'),
    ).rejects.toThrow(/Solo se reabre/);
    (store.versions.find((x) => x.id === 'b26') as Row).status = 'cerrada';
    await expect(service.reopen(LAURA, 'b26', '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const d = await service.reopen(
      LAURA,
      'b26',
      'Se cerró por error en la prueba',
    );
    expect(d.version.status).toBe('captura');
    expect(lastEvent(store)).toMatchObject({
      action: 'reabierta',
      comment: 'Se cerró por error en la prueba',
    });
  });

  it('reabrir crea el presupuesto de un área dada de alta mientras estuvo cerrada', async () => {
    const { service, store } = setup();
    (store.versions.find((x) => x.id === 'b26') as Row).status = 'cerrada';
    store.areas.push({ id: 'seguros', name: 'Seguros', is_active: true });
    await service.reopen(LAURA, 'b26', 'Falta capturar Seguros en la B-26');
    expect(
      store.budgets.filter((b) => b.version_id === 'b26').map((b) => b.area_id),
    ).toEqual(['compras', 'planta', 'seguros']);
    expect(lastEvent(store)).toMatchObject({
      action: 'reabierta',
      detail: { schema: 1, presupuestos_creados: 1 },
    });
  });

  it('cada paso bloquea la fila de la versión (FOR UPDATE) antes de revisarla', async () => {
    const { service, prisma } = setup();
    const locks = () =>
      prisma.$queryRaw.mock.calls.filter((c) =>
        c[0].join('?').includes('FOR UPDATE'),
      ).length;
    await service.setParams(LAURA, 'b27', PARAMS_B27);
    expect(locks()).toBe(1);
    const hash = (await service.detail(LILIANA, 'b27')).params.hash;
    await service.approve(LILIANA, 'b27', { params_hash: hash });
    expect(locks()).toBe(2);
    await service.open(LAURA, 'b27');
    expect(locks()).toBe(3);
    await service.giveBack(LAURA, 'b27', null);
    expect(locks()).toBe(4);
    await service.open(LAURA, 'b27');
    await service.close(LAURA, 'b27', null);
    expect(locks()).toBe(6);
    await service.reopen(LAURA, 'b27', 'Se cerró antes de tiempo');
    expect(locks()).toBe(7);
  });
});

describe('FpaService — firmantes de planeación y del CFO', () => {
  it('David queda como titular de planeación (lo nombra soporte); Uriel, del CFO (planeación)', async () => {
    const store = makeStore();
    const fpa = new FpaService(fakePrisma(store) as unknown as PrismaService);
    await fpa.assignSigner(ALEX, { duty: 'planeacion', profile_id: 'david' });
    const s = await fpa.assignSigner(LAURA, {
      duty: 'cfo',
      profile_id: 'uriel',
    });
    expect(s.planeacion.titular).toEqual({
      id: 'david',
      full_name: 'David Rodríguez',
    });
    expect(s.cfo.titular?.id).toBe('uriel');
  });

  it('otro titular revoca al anterior y nombrar al mismo no hace nada', async () => {
    const store = makeStore({ signer: 'david' });
    const fpa = new FpaService(fakePrisma(store) as unknown as PrismaService);
    await fpa.assignSigner(ALEX, { duty: 'planeacion', profile_id: 'david' });
    expect(store.assignments).toHaveLength(1);
    const s = await fpa.assignSigner(ALEX, {
      duty: 'planeacion',
      profile_id: 'liliana',
    });
    expect(s.planeacion.titular?.id).toBe('liliana');
    expect(store.assignments.find((a) => a.id === 'as-david')).toMatchObject({
      is_active: false,
      revoked_by: 'alex',
    });
  });

  it('planeación no elige a quien le da el visto bueno (403); ve que lo registra soporte', async () => {
    const store = makeStore({ signer: 'david' });
    const fpa = new FpaService(fakePrisma(store) as unknown as PrismaService);
    const attempt = fpa.assignSigner(LAURA, {
      duty: 'planeacion',
      profile_id: 'laura',
    });
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    await expect(attempt).rejects.toThrow(/lo registra soporte/);
    expect(store.assignments.find((a) => a.id === 'as-david')).toMatchObject({
      is_active: true,
    });
    expect((await fpa.listSigners(LAURA)).can_assign).toEqual({
      planeacion: false,
      cfo: true,
    });
    expect((await fpa.listSigners(ALEX)).can_assign).toEqual({
      planeacion: true,
      cfo: true,
    });
  });

  it('el firmante necesita el rol del paso (400)', async () => {
    const store = makeStore();
    const fpa = new FpaService(fakePrisma(store) as unknown as PrismaService);
    await expect(
      fpa.assignSigner(ALEX, { duty: 'planeacion', profile_id: 'uriel' }),
    ).rejects.toThrow(/rol Planeación/);
    await expect(
      fpa.assignSigner(LAURA, { duty: 'cfo', profile_id: 'diana' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
