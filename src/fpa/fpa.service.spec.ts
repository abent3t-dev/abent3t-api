import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { FpaService } from './fpa.service';
import type { FpaCalcInputDto, FpaLineInputDto } from './dto/fpa-line.dto';

/**
 * FP&A (A3) — alcance por área y validación de líneas, con Prisma EN MEMORIA
 * (cero red, cero BD). Lo que se prueba es la decisión de A2: el rol solo da
 * la entrada y fpa_assignments dice quién edita qué; planeación edita pero el
 * CFO solo lee; solo se edita en borrador o devuelto con la versión en captura.
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

const CAP_A = asUser('cap-a', ['fpa_area']);
const APR_A = asUser('apr-a', ['fpa_area']);
const CAP_B = asUser('cap-b', ['fpa_area']);
const PLAN = asUser('laura', ['fpa_planeacion']);
const CFO = asUser('uriel', ['fpa_cfo']);

const AREAS: Record<
  string,
  {
    id: string;
    name: string;
    department_id: string;
    is_active: boolean;
    sort_order: number;
  }
> = {
  A: {
    id: 'area-a',
    name: 'Compras',
    department_id: 'dep-a',
    is_active: true,
    sort_order: 1,
  },
  B: {
    id: 'area-b',
    name: 'Planta',
    department_id: 'dep-b',
    is_active: true,
    sort_order: 2,
  },
};

const ASSIGNMENTS = [
  {
    id: 'as-1',
    duty: 'captura',
    area_id: 'area-a',
    profile_id: 'cap-a',
    is_alternate: false,
    is_active: true,
  },
  {
    id: 'as-2',
    duty: 'aprobacion',
    area_id: 'area-a',
    profile_id: 'apr-a',
    is_alternate: false,
    is_active: true,
  },
  {
    id: 'as-3',
    duty: 'captura',
    area_id: 'area-b',
    profile_id: 'cap-b',
    is_alternate: false,
    is_active: true,
  },
];

const version = (
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  code: id.toUpperCase(),
  name: `Versión ${id}`,
  fiscal_year: 2026,
  kind: 'presupuesto',
  status,
  cutoff_month: null,
  inflation_pct: D('4.000'),
  is_active: true,
  fpa_exchange_rates: [{ currency: 'USD', rate_mxn: D('20.000000') }],
  fpa_travel_rates: [
    {
      trip_type: 'nacional',
      traveler_type: 'colaborador',
      flight_per_person: D(4000),
      hotel_per_night: D(2500),
      transport_per_day: D(500),
      meals_per_day: D(1000),
    },
  ],
  ...extra,
});

const VERSIONS: Record<string, ReturnType<typeof version>> = {
  'b-26': version('b-26', 'captura'),
  prep: version('prep', 'preparacion'),
  closed: version('closed', 'cerrada'),
};

const budget = (
  id: string,
  area: keyof typeof AREAS,
  versionId: string,
  status = 'borrador',
) => ({
  id,
  version_id: versionId,
  area_id: AREAS[area].id,
  status,
  current_round: status === 'borrador' ? 0 : 1,
  is_active: true,
});

const BUDGETS: Record<string, ReturnType<typeof budget>> = {
  'bud-a': budget('bud-a', 'A', 'b-26'),
  'bud-b': budget('bud-b', 'B', 'b-26'),
  'bud-a-sent': budget('bud-a-sent', 'A', 'closed', 'enviado'),
  'bud-a-closed': budget('bud-a-closed', 'A', 'closed'),
  'bud-a-prep': budget('bud-a-prep', 'A', 'prep'),
};

const CLASSIFICATIONS: Record<
  string,
  {
    id: string;
    name: string;
    allows_negative: boolean;
    category: { id: string; name: string; sort_order: number };
  }
> = {
  'cls-sp': {
    id: 'cls-sp',
    name: 'Servicios Profesionales',
    allows_negative: false,
    category: { id: 'cat-sp', name: 'Servicios Profesionales', sort_order: 1 },
  },
  'cls-d5': {
    id: 'cls-d5',
    name: 'Renta Oficina D-5',
    allows_negative: true,
    category: { id: 'cat-arr', name: 'Arrendamientos', sort_order: 2 },
  },
};

/**
 * Prisma en memoria: solo lo que usa el service en estos casos.
 * `lockedStatus`: el estado que encuentra el candado dentro de la transacción,
 * para simular que alguien envió el presupuesto entre la revisión y el guardado.
 */
function fakePrisma(opts: { lockedStatus?: string } = {}) {
  const created: {
    line?: Record<string, unknown>;
    months: Record<string, unknown>[];
    budgets: Record<string, unknown>[];
  } = { months: [], budgets: [] };
  const lineFor = (id: string) => {
    const data = created.line ?? {};
    const cls = CLASSIFICATIONS[(data.classification_id as string) ?? 'cls-sp'];
    return {
      id,
      line_key_id: 'key-1',
      sort_order: 1,
      fpa_line_keys: { number: 123 },
      fpa_departments: { id: data.department_id ?? 'dep-a', name: 'Compras' },
      fpa_classifications: {
        id: cls.id,
        name: cls.name,
        fpa_categories: cls.category,
      },
      fpa_budget_line_months: created.months.map((m) => ({
        month: m.month,
        quantity: m.quantity == null ? null : D(m.quantity as string),
        unit_price: m.unit_price == null ? null : D(m.unit_price as string),
        amount: m.amount == null ? null : D(m.amount as string),
        trips: m.trips ?? null,
      })),
      unit_price: data.unit_price == null ? null : D(data.unit_price as string),
      car_rental: null,
      ...data,
    };
  };
  const prisma = {
    fpa_assignments: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          ASSIGNMENTS.filter((a) => {
            if (where.profile_id && a.profile_id !== where.profile_id)
              return false;
            const areaIn = (where.area_id as { in?: string[] } | undefined)?.in;
            if (areaIn && !areaIn.includes(a.area_id)) return false;
            if (where.is_alternate === false && a.is_alternate) return false;
            return a.is_active;
          }).map((a) => ({
            ...a,
            fpa_areas:
              Object.values(AREAS).find((x) => x.id === a.area_id) ?? null,
            profiles_fpa_assignments_profile_idToprofiles: {
              id: a.profile_id,
              full_name: a.profile_id,
              email: `${a.profile_id}@abent3t.com`,
            },
          })),
        ),
      ),
    },
    fpa_versions: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(VERSIONS[where.id] ?? null),
      ),
    },
    fpa_budgets: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.budgets.push(data);
        return Promise.resolve({ id: `bud-${created.budgets.length}` });
      }),
      findFirst: jest.fn(({ where }: { where: { id: string } }) => {
        const b = BUDGETS[where.id];
        if (!b) return Promise.resolve(null);
        const area = Object.values(AREAS).find((x) => x.id === b.area_id);
        return Promise.resolve({
          ...b,
          fpa_areas: area,
          fpa_versions: VERSIONS[b.version_id],
          fpa_budget_lines: [],
        });
      }),
      findMany: jest.fn(
        ({
          where,
        }: {
          where: { version_id: string; area_id?: { in: string[] } };
        }) =>
          Promise.resolve(
            Object.values(BUDGETS)
              .filter(
                (b) =>
                  b.version_id === where.version_id &&
                  (!where.area_id || where.area_id.in.includes(b.area_id)),
              )
              .map((b) => ({
                ...b,
                fpa_areas: Object.values(AREAS).find((x) => x.id === b.area_id),
                fpa_budget_lines: [],
              })),
          ),
      ),
    },
    fpa_areas: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      aggregate: jest.fn(() => Promise.resolve({ _max: { sort_order: 2 } })),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'area-new', ...data }),
      ),
      update: jest.fn(() => Promise.resolve({ id: 'area-new' })),
      findMany: jest.fn(() =>
        Promise.resolve(
          [
            ...Object.values(AREAS),
            {
              id: 'area-new',
              name: 'Seguros',
              department_id: 'dep-new',
              is_active: true,
              sort_order: 3,
            },
          ].map((a) => ({
            ...a,
            fpa_departments_fpa_areas_department_idTofpa_departments: {
              id: a.department_id,
              name: a.name,
            },
          })),
        ),
      ),
    },
    fpa_departments: {
      create: jest.fn(() => Promise.resolve({ id: 'dep-new' })),
      findFirst: jest.fn(
        ({ where }: { where: { id?: string; name?: { equals: string } } }) => {
          if (where.name) {
            // IT ya existe y lo captura Recursos Humanos (como en dev)
            return Promise.resolve(
              where.name.equals.toLowerCase() === 'it'
                ? {
                    id: 'dep-it',
                    name: 'IT',
                    area_id: 'area-rh',
                    fpa_areas_fpa_departments_area_idTofpa_areas: {
                      name: 'Recursos Humanos',
                    },
                  }
                : null,
            );
          }
          return Promise.resolve(
            ['dep-a', 'dep-b'].includes(where.id ?? '')
              ? { id: where.id }
              : null,
          );
        },
      ),
    },
    fpa_classifications: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(CLASSIFICATIONS[where.id] ?? null),
      ),
    },
    suppliers: {
      findUnique: jest.fn(() =>
        Promise.resolve({ legal_name: 'FIDELITAS SA DE CV' }),
      ),
    },
    fpa_line_keys: {
      create: jest.fn(() => Promise.resolve({ id: 'key-1' })),
    },
    fpa_budget_lines: {
      aggregate: jest.fn(() => Promise.resolve({ _max: { sort_order: 0 } })),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.line = data;
        return Promise.resolve({ id: 'line-1' });
      }),
      findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(lineFor(where.id)),
      ),
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === 'line-1' ? { id: 'line-1', budget_id: 'bud-a' } : null,
        ),
      ),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.line = { ...(created.line ?? {}), ...data };
        return Promise.resolve({ id: 'line-1' });
      }),
    },
    fpa_budget_line_months: {
      createMany: jest.fn(({ data }: { data: Record<string, unknown>[] }) => {
        created.months = data;
        return Promise.resolve({ count: data.length });
      }),
      deleteMany: jest.fn(() => {
        created.months = [];
        return Promise.resolve({ count: 0 });
      }),
    },
  };
  // Los SELECT … FOR SHARE de las escrituras (candados dentro de la transacción)
  const $queryRaw = jest.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM fpa_budgets b JOIN fpa_versions v')) {
        const b = BUDGETS[values[0] as string];
        if (!b) return Promise.resolve([]);
        const v = VERSIONS[b.version_id];
        return Promise.resolve([
          {
            status: opts.lockedStatus ?? b.status,
            is_active: b.is_active,
            version_status: v.status,
            code: v.code,
          },
        ]);
      }
      if (sql.includes('FROM fpa_versions')) {
        return Promise.resolve(
          Object.values(VERSIONS)
            .filter((v) => ['preparacion', 'captura'].includes(v.status))
            .map((v) => ({ id: v.id, status: v.status })),
        );
      }
      return Promise.resolve([]);
    },
  );
  // La transacción corre el callback con el mismo Prisma en memoria
  return Object.assign(prisma, {
    $queryRaw,
    created,
    $transaction: jest.fn((fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    ),
  });
}

const ELVA: FpaLineInputDto = {
  department_id: 'dep-a',
  classification_id: 'cls-sp',
  concept: 'Proyecto de mejora dashboard Compras',
  supplier_name: 'ELVA MARIA LARA PALOMARES',
  calc_method: 'precio_veces',
  currency: 'MXN',
  price_index: 'precio_acordado',
  unit_price: '7500',
  months: [2, 3, 4, 5].map((month) => ({ month, quantity: '1' })),
} as FpaLineInputDto;

describe('FpaService — quién edita qué', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let service: FpaService;

  beforeEach(() => {
    prisma = fakePrisma();
    service = new FpaService(prisma as unknown as PrismaService);
  });

  it('quien captura el área agrega una línea y la recibe calculada ($30,000)', async () => {
    const line = await service.createLine(CAP_A, 'bud-a', ELVA);
    expect(line.folio).toBe('L-000123');
    expect(line.total_mxn).toBe('30000.00');
    expect(line.months[1].amount_mxn).toBe('7500.00');
    expect(prisma.fpa_budget_line_months.createMany).toHaveBeenCalledTimes(1);
  });

  it('planeación edita en cualquier área (decisión 3 de A2)', async () => {
    await expect(
      service.createLine(PLAN, 'bud-b', ELVA),
    ).resolves.toMatchObject({ total_mxn: '30000.00' });
  });

  it('quien aprueba el área no captura (403)', async () => {
    await expect(
      service.createLine(APR_A, 'bud-a', ELVA),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('quien captura otra área no edita esta (403)', async () => {
    await expect(
      service.createLine(CAP_B, 'bud-a', ELVA),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el CFO solo lee (403 aunque llegara al service)', async () => {
    await expect(service.createLine(CFO, 'bud-a', ELVA)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('un presupuesto enviado no se edita (409)', async () => {
    await expect(
      service.createLine(CAP_A, 'bud-a-sent', ELVA),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('una versión cerrada no se edita (409), ni siquiera planeación', async () => {
    await expect(
      service.createLine(PLAN, 'bud-a-closed', ELVA),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('editar y dar de baja guardan quién la cambió por última vez (B4)', async () => {
    await service.updateLine(CAP_A, 'line-1', ELVA);
    expect(prisma.fpa_budget_lines.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ updated_by: 'cap-a' }) as unknown,
      }),
    );
    await service.deactivateLine(PLAN, 'line-1');
    expect(prisma.fpa_budget_lines.update).toHaveBeenLastCalledWith({
      where: { id: 'line-1' },
      data: { is_active: false, updated_by: 'laura' },
    });
  });

  it('guardar vuelve a revisar el estado con candado: si lo enviaron entre tanto, 409 y no guarda', async () => {
    const racing = fakePrisma({ lockedStatus: 'enviado' });
    const svc = new FpaService(racing as unknown as PrismaService);
    await expect(svc.createLine(CAP_A, 'bud-a', ELVA)).rejects.toThrow(
      /está enviado: no se puede editar/,
    );
    expect(racing.fpa_budget_lines.create).not.toHaveBeenCalled();
    await expect(svc.deactivateLine(CAP_A, 'line-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(racing.fpa_budget_lines.update).not.toHaveBeenCalled();
    const sql = racing.$queryRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('FOR SHARE OF b, v');
  });

  it('editar y dar de baja pasan por las mismas reglas', async () => {
    await expect(
      service.updateLine(CAP_B, 'line-1', ELVA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.deactivateLine(CFO, 'line-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.deactivateLine(CAP_A, 'line-1')).resolves.toEqual({
      ok: true,
    });
    await expect(
      service.updateLine(CAP_A, 'no-existe', ELVA),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('FpaService — quién ve qué', () => {
  let service: FpaService;

  beforeEach(() => {
    service = new FpaService(fakePrisma() as unknown as PrismaService);
  });

  it('un área ve su presupuesto; otra área no (403)', async () => {
    await expect(service.getBudget(APR_A, 'bud-a')).resolves.toMatchObject({
      id: 'bud-a',
      can_edit: false,
    });
    await expect(service.getBudget(CAP_B, 'bud-a')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('planeación y el CFO ven todas las áreas; solo planeación puede editar', async () => {
    await expect(service.getBudget(PLAN, 'bud-a')).resolves.toMatchObject({
      can_edit: true,
    });
    await expect(service.getBudget(CFO, 'bud-b')).resolves.toMatchObject({
      can_edit: false,
    });
  });

  it('quien captura ve el botón de editar en su área', async () => {
    await expect(service.getBudget(CAP_A, 'bud-a')).resolves.toMatchObject({
      can_edit: true,
      total_mxn: '0.00',
    });
  });

  it('una versión en preparación no la ven las áreas (404), sí planeación', async () => {
    await expect(service.getBudget(CAP_A, 'bud-a-prep')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getBudget(PLAN, 'bud-a-prep')).resolves.toMatchObject({
      id: 'bud-a-prep',
    });
  });
});

describe('FpaService — vista previa del cálculo (B1)', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let service: FpaService;

  beforeEach(() => {
    prisma = fakePrisma();
    service = new FpaService(prisma as unknown as PrismaService);
  });

  const CIERRE_PARO = {
    budget_id: 'bud-a',
    calc_method: 'viaje',
    currency: 'MXN',
    price_index: 'precio_acordado',
    unit_price: null,
    trip: {
      trip_type: 'nacional',
      travelers_colaborador: 2,
      travelers_director: 0,
      nights: 2,
      car_rental: false,
    },
    months: [{ month: 3, trips: 1 }],
  } as FpaCalcInputDto;

  it('calcula el viaje con su desglose y no guarda nada (Cierre paro 2026 = $25,500)', async () => {
    const r = await service.calculate(CAP_A, CIERRE_PARO);
    expect(r.errors).toEqual([]);
    expect(r.total_mxn).toBe('25500.00');
    expect(r.months[2].amount_mxn).toBe('25500.00');
    expect(r.trip_breakdown).toMatchObject({
      nights: 2,
      days: 3,
      per_trip: '25500.00',
      trips: 1,
      transport: { traveler_type: 'colaborador', amount: '1500.00' },
      travelers: [
        {
          traveler_type: 'colaborador',
          count: 2,
          flight: '8000.00',
          hotel: '10000.00',
          meals: '6000.00',
        },
      ],
    });
    expect(prisma.fpa_budget_lines.create).not.toHaveBeenCalled();
    expect(prisma.fpa_budget_line_months.createMany).not.toHaveBeenCalled();
  });

  it('precio × veces: los meses y el total en pesos, sin desglose de viaje', async () => {
    const r = await service.calculate(CAP_A, {
      budget_id: 'bud-a',
      calc_method: 'precio_veces',
      currency: 'USD',
      price_index: 'inflacion',
      unit_price: '1000',
      months: [{ month: 1, quantity: '1' }],
    } as FpaCalcInputDto);
    expect(r.total_currency).toBe('1040.00');
    expect(r.total_mxn).toBe('20800.00');
    expect(r.trip_breakdown).toBeNull();
  });

  it('lo que el alta rechazaría viene en errors (un viaje en dólares)', async () => {
    const r = await service.calculate(CAP_A, {
      ...CIERRE_PARO,
      currency: 'USD',
    } as FpaCalcInputDto);
    expect(r.errors.join('. ')).toMatch(/Un viaje va en pesos/);
  });

  it('sin tarifa para un director, la línea sale "No disponible" con el motivo', async () => {
    const r = await service.calculate(CAP_A, {
      ...CIERRE_PARO,
      trip: { ...CIERRE_PARO.trip!, travelers_director: 1 },
    } as FpaCalcInputDto);
    expect(r.total_mxn).toBeNull();
    expect(r.unavailable_reason).toMatch(/director/);
    expect(r.trip_breakdown).toBeNull();
  });

  it('respeta el alcance: otra área no (403), su aprobador sí, y una versión en preparación no la ve un área (404)', async () => {
    await expect(service.calculate(CAP_B, CIERRE_PARO)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.calculate(APR_A, CIERRE_PARO)).resolves.toMatchObject({
      total_mxn: '25500.00',
    });
    await expect(
      service.calculate(CAP_A, {
        ...CIERRE_PARO,
        budget_id: 'bud-a-prep',
      } as FpaCalcInputDto),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.calculate(CAP_A, {
        ...CIERRE_PARO,
        budget_id: 'no-existe',
      } as FpaCalcInputDto),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el detalle de una línea guardada trae su desglose', async () => {
    const line = await service.createLine(CAP_A, 'bud-a', {
      ...ELVA,
      calc_method: 'viaje',
      unit_price: null,
      supplier_name: null,
      trip: CIERRE_PARO.trip,
      months: CIERRE_PARO.months,
    } as FpaLineInputDto);
    expect(line.total_mxn).toBe('25500.00');
    expect(line.trip_breakdown?.per_trip).toBe('25500.00');
  });
});

describe('FpaService — validación de la línea (mensajes claros, no solo el CHECK)', () => {
  let service: FpaService;

  beforeEach(() => {
    service = new FpaService(fakePrisma() as unknown as PrismaService);
  });

  const expect400 = async (dto: Partial<FpaLineInputDto>, message: RegExp) => {
    const call = service.createLine(CAP_A, 'bud-a', {
      ...ELVA,
      ...dto,
    } as FpaLineInputDto);
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(call).rejects.toThrow(message);
  };

  it('una moneda sin tipo de cambio en la versión', () =>
    expect400({ currency: 'GBP' }, /tipo de cambio de GBP/));

  it('precio × veces sin precio', () =>
    expect400({ unit_price: null }, /falta el precio/));

  it('un monto en una línea de precio × veces', () =>
    expect400(
      { months: [{ month: 1, amount: '50' }] },
      /debe traer las veces/,
    ));

  it('un monto negativo donde la clasificación no lo acepta', () =>
    expect400(
      {
        calc_method: 'monto_mes',
        unit_price: null,
        months: [{ month: 1, amount: '-100' }],
      },
      /no acepta montos negativos/,
    ));

  it('un negativo sí pasa en una clasificación de ajuste (D-5)', async () => {
    const line = await service.createLine(CAP_A, 'bud-a', {
      ...ELVA,
      classification_id: 'cls-d5',
      calc_method: 'monto_mes',
      unit_price: null,
      months: [{ month: 1, amount: '-517675' }],
    } as FpaLineInputDto);
    expect(line.total_mxn).toBe('-517675.00');
  });

  it('un viaje en dólares', () =>
    expect400(
      {
        calc_method: 'viaje',
        currency: 'USD',
        unit_price: null,
        trip: {
          trip_type: 'nacional',
          travelers_colaborador: 1,
          travelers_director: 0,
          nights: 1,
          car_rental: false,
        },
        months: [{ month: 1, trips: 1 }],
      },
      /Un viaje va en pesos/,
    ));

  it('un gasto sin proveedor (ni OTROS)', () =>
    expect400(
      { supplier_name: null, supplier_id: null },
      /Falta el proveedor/,
    ));

  it('el proveedor del catálogo guarda la copia de su nombre', async () => {
    const line = await service.createLine(CAP_A, 'bud-a', {
      ...ELVA,
      supplier_id: '00000000-0000-4000-8000-000000000001',
      supplier_name: 'cualquier texto',
    } as FpaLineInputDto);
    expect(line.supplier_name).toBe('FIDELITAS SA DE CV');
  });
});

describe('FpaService — la lista y el consolidado respetan el alcance', () => {
  let service: FpaService;

  beforeEach(() => {
    service = new FpaService(fakePrisma() as unknown as PrismaService);
  });

  it('quien captura Planta solo lista Planta', async () => {
    const rows = await service.listBudgets(CAP_B, 'b-26');
    expect(rows.map((r) => r.area.name)).toEqual(['Planta']);
    expect(rows[0].can_edit).toBe(true);
  });

  it('planeación y el CFO listan las dos áreas; el CFO sin editar', async () => {
    const plan = await service.listBudgets(PLAN, 'b-26');
    expect(plan.map((r) => r.area.name)).toEqual(['Compras', 'Planta']);
    const cfo = await service.listBudgets(CFO, 'b-26');
    expect(cfo.every((r) => !r.can_edit)).toBe(true);
  });

  it('el consolidado de quien captura Compras solo trae Compras', async () => {
    const data = await service.consolidated(CAP_A, 'b-26', 'area');
    expect(data.rows.map((r) => r.label)).toEqual(['Compras']);
  });

  it('el consolidado del CFO trae las dos áreas', async () => {
    const data = await service.consolidated(CFO, 'b-26', 'area');
    expect(data.rows.map((r) => r.label)).toEqual(['Compras', 'Planta']);
    expect(data.totals.total_mxn).toBe('0.00');
  });

  it('el Excel sale del mismo consolidado con alcance', async () => {
    const out = await service.consolidatedExcel(CAP_B, 'b-26', 'area');
    expect(out.filename).toMatch(/^FPA_consolidado_B-26_/);
    expect(out.buffer.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('FpaService — alta de área', () => {
  it('un área nueva recibe presupuesto en las versiones abiertas, leídas con candado', async () => {
    const prisma = fakePrisma();
    const service = new FpaService(prisma as unknown as PrismaService);
    const row = await service.createArea(PLAN, 'Seguros');
    expect(row).toMatchObject({ id: 'area-new', name: 'Seguros' });
    // Solo la B-26 está en captura: la de preparación no recibe presupuesto
    expect(prisma.created.budgets).toEqual([
      { version_id: 'b-26', area_id: 'area-new', created_by: 'laura' },
    ]);
    const sql = prisma.$queryRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('FOR SHARE');
  });

  it('un área con el nombre de un departamento de otra área responde 409, no 500', async () => {
    const service = new FpaService(fakePrisma() as unknown as PrismaService);
    await expect(service.createArea(PLAN, 'IT')).rejects.toThrow(
      /lo captura Recursos Humanos/,
    );
    await expect(service.createArea(PLAN, 'IT')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
