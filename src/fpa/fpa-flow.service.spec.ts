import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { EmailService } from '../email/email.service';
import type { SocketService } from '../socket/socket.service';
import type { BusinessDaysService } from '../common/services/business-days.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { calculateBusinessDays } from '../common/utils/business-days';
import { FpaFlowService } from './fpa-flow.service';
import type { FpaService } from './fpa.service';
import type { FpaFlowActionDto } from './dto/fpa-flow.dto';
import type { SnapshotLine } from './fpa-flow';

/**
 * FP&A (B3) — flujo de aprobación con Prisma EN MEMORIA (cero red, cero BD).
 * El caso es el de las pruebas de 0021 en Compras: Diana captura (Jorge es
 * su suplente), Ingrid aprueba el área, David firma planeación (Laura de
 * suplente) y el CFO firma por rol (Uriel). La ronda 1 se rechaza en
 * planeación y la 2, enviada por el suplente, se aprueba completa.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

const asUser = (id: string, roles: string[]): AuthUser =>
  ({
    id,
    email: `${id}@abent3t.com`,
    full_name: id.charAt(0).toUpperCase() + id.slice(1),
    role: roles[0],
    roles,
    role_assignments: roles.map((role) => ({ module: 'fpa', role })),
    department_id: null,
    is_active: true,
  }) as AuthUser;

const DIANA = asUser('diana', ['fpa_area']);
const JORGE = asUser('jorge', ['fpa_area']);
const INGRID = asUser('ingrid', ['fpa_area']);
const DAVID = asUser('david', ['fpa_planeacion']);
const LAURA = asUser('laura', ['fpa_planeacion']);
const LILIANA = asUser('liliana', ['fpa_planeacion']);
const URIEL = asUser('uriel', ['fpa_cfo']);
const ALEX = asUser('alex', ['super_admin']);

interface Row {
  id: string;
  [k: string]: unknown;
}

const line = (key: string, concept: string, total: string): SnapshotLine => ({
  line_key_id: key,
  folio: `L-00000${key.slice(1)}`,
  concept,
  total_mxn: total,
  months: [{ month: 3, amount_mxn: total }],
});

function makeStore() {
  const profiles: Row[] = [
    'diana',
    'jorge',
    'ingrid',
    'david',
    'laura',
    'liliana',
    'uriel',
    'alex',
  ].map((id) => ({
    id,
    full_name: id.charAt(0).toUpperCase() + id.slice(1),
    email: `${id}@abent3t.com`,
    is_active: true,
  }));
  const asg = (
    profile_id: string,
    duty: string,
    area_id: string | null,
    is_alternate = false,
  ): Row => ({
    id: `as-${profile_id}-${duty}-${area_id ?? 'general'}`,
    profile_id,
    duty,
    area_id,
    is_alternate,
    is_active: true,
    created_at: new Date('2026-10-26T00:00:00Z'),
  });
  return {
    profiles,
    versions: [
      {
        id: 'b26',
        code: 'B-26',
        name: 'Presupuesto 2026',
        status: 'captura',
        is_active: true,
      },
    ] as Row[],
    areas: [
      { id: 'compras', name: 'Compras' },
      { id: 'dg', name: 'Dirección General' },
    ] as Row[],
    budgets: [
      {
        id: 'bud-compras',
        version_id: 'b26',
        area_id: 'compras',
        status: 'borrador',
        current_round: 0,
        submitted_at: null,
        approved_at: null,
        is_active: true,
        updated_at: new Date('2026-10-27T18:00:00Z'),
      },
      {
        id: 'bud-dg',
        version_id: 'b26',
        area_id: 'dg',
        status: 'borrador',
        current_round: 0,
        submitted_at: null,
        approved_at: null,
        is_active: true,
        updated_at: new Date('2026-10-27T18:00:00Z'),
      },
    ] as Row[],
    assignments: [
      asg('diana', 'captura', 'compras'),
      asg('jorge', 'captura', 'compras', true),
      asg('ingrid', 'aprobacion', 'compras'),
      asg('laura', 'captura', 'dg'),
      asg('david', 'aprobacion', 'dg'),
      asg('david', 'planeacion', null),
      asg('laura', 'planeacion', null, true),
    ],
    roles: [
      { profile_id: 'david', role: 'fpa_planeacion' },
      { profile_id: 'laura', role: 'fpa_planeacion' },
      { profile_id: 'liliana', role: 'fpa_planeacion' },
      { profile_id: 'uriel', role: 'fpa_cfo' },
    ],
    events: [] as Row[],
    /** Lo que regresa la foto (FpaService.budgetSnapshot) de cada presupuesto. */
    photos: {
      'bud-compras': {
        total: '340000.00',
        lines: [
          line('k1', 'Evaluación de proveedores', '150000.00'),
          line('k2', 'Mapeo de procesos', '190000.00'),
        ],
        unavailable: false,
      },
      'bud-dg': {
        total: '50000.00',
        lines: [line('k9', 'Asesoría', '50000.00')],
        unavailable: false,
      },
    } as Record<
      string,
      { total: string | null; lines: SnapshotLine[]; unavailable: boolean }
    >,
  };
}

type Store = ReturnType<typeof makeStore>;

/** where de Prisma: igualdad, `in`, null y OR (lo que usa el service). */
function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') {
      return (v as Record<string, unknown>[]).some((w) => matches(row, w));
    }
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const cond = v as Record<string, unknown>;
      if ('in' in cond) return (cond.in as unknown[]).includes(row[k]);
      throw new Error(`El fake no sabe filtrar por ${k}`);
    }
    return row[k] === v;
  });
}

let clock = Date.parse('2026-11-02T16:00:00Z');

function fakePrisma(store: Store) {
  const profileOf = (id: unknown) =>
    store.profiles.find((p) => p.id === id) as Row;
  const withRefs = (b: Row) => ({
    ...b,
    fpa_areas: store.areas.find((a) => a.id === b.area_id),
    fpa_versions: store.versions.find((v) => v.id === b.version_id),
  });
  const budgetMatches = (b: Row, where: Record<string, unknown>) => {
    const { fpa_versions: versionWhere, ...rest } = where;
    if (!matches(b, rest)) return false;
    if (versionWhere) {
      const v = store.versions.find((x) => x.id === b.version_id) as Row;
      return matches(v, versionWhere as Record<string, unknown>);
    }
    return true;
  };
  const eventOut = (e: Row, select?: Record<string, unknown>) => {
    if (select && !('profiles' in select)) {
      return Object.fromEntries(Object.keys(select).map((k) => [k, e[k]]));
    }
    return { ...e, profiles: profileOf(e.actor_profile_id) };
  };
  const prisma = {
    fpa_budgets: {
      findFirst: jest.fn(
        ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, boolean>;
        }) => {
          const b = store.budgets.find((x) => budgetMatches(x, where));
          if (!b) return Promise.resolve(null);
          if (select) {
            return Promise.resolve(
              Object.fromEntries(Object.keys(select).map((k) => [k, b[k]])),
            );
          }
          return Promise.resolve(withRefs(b));
        },
      ),
      findMany: jest.fn(
        ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, boolean>;
        }) =>
          Promise.resolve(
            store.budgets
              .filter((b) => budgetMatches(b, where))
              .map((b) =>
                select
                  ? Object.fromEntries(
                      Object.keys(select).map((k) => [k, b[k]]),
                    )
                  : withRefs(b),
              ),
          ),
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const b = store.budgets.find((x) => matches(x, where));
          if (!b) return Promise.resolve({ count: 0 });
          Object.assign(b, data, { updated_at: new Date(clock) });
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    fpa_assignments: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          store.assignments
            .filter((a) => matches(a, where))
            .map((a) => ({
              ...a,
              profiles_fpa_assignments_profile_idToprofiles: profileOf(
                a.profile_id,
              ),
            })),
        ),
      ),
      count: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          store.assignments.filter((a) => matches(a, where)).length,
        ),
      ),
    },
    fpa_budget_events: {
      findMany: jest.fn(
        ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select?: Record<string, unknown>;
        }) =>
          Promise.resolve(
            store.events
              .filter((e) => matches(e, where))
              .sort(
                (a, b) =>
                  (a.created_at as Date).getTime() -
                  (b.created_at as Date).getTime(),
              )
              .map((e) => eventOut(e, select)),
          ),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        clock += 60_000;
        const row: Row = {
          id: `ev-${store.events.length + 1}`,
          created_at: new Date(clock),
          ...data,
          snapshot: data.snapshot === Prisma.DbNull ? null : data.snapshot,
          total_mxn:
            data.total_mxn === null || data.total_mxn === undefined
              ? null
              : D(data.total_mxn as string),
        };
        store.events.push(row);
        return Promise.resolve(eventOut(row));
      }),
    },
    user_roles: {
      findMany: jest.fn(({ where }: { where: { role: string } }) =>
        Promise.resolve(
          store.roles
            .filter((r) => r.role === where.role)
            .map((r) => ({
              ...r,
              profiles_user_roles_profile_idToprofiles: profileOf(r.profile_id),
            })),
        ),
      ),
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

function setup() {
  const store = makeStore();
  const prisma = fakePrisma(store);
  const fpa = {
    budgetSnapshot: jest.fn((_db: unknown, id: string) => {
      const p = store.photos[id];
      return Promise.resolve({
        snapshot: {
          schema: 1,
          budget_id: id,
          total_mxn: p.total,
          lines: p.lines,
        },
        total_mxn: p.total,
        line_count: p.lines.length,
        has_unavailable: p.unavailable,
      });
    }),
  };
  const email = {
    enqueue: jest.fn(() => Promise.resolve({ status: 'pendiente', key: 'k' })),
  };
  const socket = { emitToUser: jest.fn<void, [string, string, unknown]>() };
  const businessDays = {
    calculate: jest.fn((a: string, b: string) =>
      Promise.resolve(calculateBusinessDays(a, b, [])),
    ),
  };
  const service = new FpaFlowService(
    prisma as unknown as PrismaService,
    fpa as unknown as FpaService,
    email as unknown as EmailService,
    socket as unknown as SocketService,
    businessDays as unknown as BusinessDaysService,
  );
  return { store, prisma, fpa, email, socket, service };
}

type Ctx = ReturnType<typeof setup>;

/** Lo que la pantalla tenía a la vista. */
const seen = (ctx: Ctx, id: string, comment?: string): FpaFlowActionDto => {
  const b = ctx.store.budgets.find((x) => x.id === id) as Row;
  return {
    expected_status: b.status as FpaFlowActionDto['expected_status'],
    expected_round: b.current_round as number,
    comment: comment ?? null,
  };
};

const budget = (ctx: Ctx, id = 'bud-compras') =>
  ctx.store.budgets.find((x) => x.id === id) as Row;

type EmailCall = {
  template: string;
  entityId: string;
  to: { email: string };
  subject: string;
  body: string;
};
const emails = (ctx: Ctx) =>
  ctx.email.enqueue.mock.calls.map((c) => (c as unknown as [EmailCall])[0]);
const screens = (ctx: Ctx) => ctx.socket.emitToUser.mock.calls.map((c) => c[0]);

describe('FpaFlowService — el caso de las pruebas de 0021 (Compras)', () => {
  it('ronda 1 rechazada en planeación; ronda 2, enviada por el suplente, aprobada completa', async () => {
    const ctx = setup();
    const id = 'bud-compras';

    // Ronda 1: Diana envía (foto con el total) y le avisa a Ingrid
    let f = await ctx.service.submit(DIANA, id, seen(ctx, id));
    expect(budget(ctx)).toMatchObject({ status: 'enviado', current_round: 1 });
    expect(ctx.store.events[0]).toMatchObject({
      round: 1,
      action: 'enviado',
      acting_as: 'titular',
      actor_role: 'fpa_area',
    });
    expect((ctx.store.events[0].total_mxn as Prisma.Decimal).toFixed(2)).toBe(
      '340000.00',
    );
    expect(emails(ctx)).toEqual([
      expect.objectContaining({
        template: 'fpa_turno',
        entityId: 'bud-compras:r1:area',
        to: expect.objectContaining({ email: 'ingrid@abent3t.com' }) as unknown,
      }),
    ]);
    expect(screens(ctx)).toEqual(['ingrid']);
    expect(f.turn).toMatchObject({
      step: 'area',
      label: 'Turno de quien aprueba el área',
    });

    // Ingrid aprueba el área: el correo va al titular de planeación (David),
    // el aviso en pantalla a los dos firmantes
    await ctx.service.approve(INGRID, id, seen(ctx, id));
    expect(budget(ctx).status).toBe('aprobado_area');
    expect(
      emails(ctx)
        .slice(1)
        .map((e) => e.to.email),
    ).toEqual(['david@abent3t.com']);
    expect(screens(ctx).slice(1)).toEqual(['david', 'laura']);

    // David lo regresa con comentario: regresa a captura
    await ctx.service.reject(
      DAVID,
      id,
      seen(ctx, id, 'Falta justificar <el mapeo> & el monto'),
    );
    expect(budget(ctx)).toMatchObject({ status: 'devuelto', current_round: 1 });
    const devuelto = emails(ctx)[2];
    expect(devuelto).toMatchObject({
      template: 'fpa_devuelto',
      entityId: 'bud-compras:r1:planeacion',
      to: { email: 'diana@abent3t.com' },
    });
    expect(devuelto.body).toContain(
      'Falta justificar &lt;el mapeo&gt; &amp; el monto',
    );

    // Ronda 2: el suplente (Jorge) la reenvía con otra foto
    ctx.store.photos[id] = {
      total: '330000.00',
      lines: [
        line('k1', 'Evaluación de proveedores', '150000.00'),
        line('k3', 'Curso de negociación', '180000.00'),
      ],
      unavailable: false,
    };
    await ctx.service.submit(JORGE, id, seen(ctx, id));
    expect(budget(ctx)).toMatchObject({ status: 'enviado', current_round: 2 });
    expect(ctx.store.events[3]).toMatchObject({
      round: 2,
      action: 'enviado',
      acting_as: 'suplente',
    });

    // Área otra vez (ronda nueva), planeación por la suplente y el CFO por rol
    await ctx.service.approve(INGRID, id, seen(ctx, id));
    await ctx.service.approve(LAURA, id, seen(ctx, id));
    expect(ctx.store.events[5]).toMatchObject({
      step: 'planeacion',
      acting_as: 'suplente',
    });
    f = await ctx.service.approve(URIEL, id, seen(ctx, id));
    expect(budget(ctx).status).toBe('aprobado_cfo');
    expect(budget(ctx).approved_at).toBeInstanceOf(Date);
    expect(ctx.store.events[6]).toMatchObject({
      step: 'cfo',
      acting_as: 'rol',
      actor_role: 'fpa_cfo',
    });
    // Aprobado: avisa a quien envió (Jorge) y a quien captura (Diana)
    expect(
      emails(ctx)
        .filter((e) => e.template === 'fpa_aprobado')
        .map((e) => e.to.email)
        .sort(),
    ).toEqual(['diana@abent3t.com', 'jorge@abent3t.com']);

    // La línea de tiempo por ronda, con qué cambió
    expect(f.rounds.map((r) => r.round)).toEqual([2, 1]);
    expect(
      f.rounds[1].events.map((e) => `${e.action}:${e.step ?? '-'}`),
    ).toEqual(['enviado:-', 'aprobado:area', 'rechazado:planeacion']);
    expect(f.rounds[0].changes).toMatchObject({
      total_before: '340000.00',
      total_after: '330000.00',
      delta: '-10000.00',
      added: [{ folio: 'L-000003' }],
      removed: [{ folio: 'L-000002' }],
    });
    expect(f.turn).toMatchObject({ step: null, label: 'Aprobado' });
  });
});

describe('FpaFlowService — turnos, choques y reintentos', () => {
  async function atPlaneacion() {
    const ctx = setup();
    await ctx.service.submit(DIANA, 'bud-compras', seen(ctx, 'bud-compras'));
    await ctx.service.approve(INGRID, 'bud-compras', seen(ctx, 'bud-compras'));
    return ctx;
  }

  it('fuera de turno: 403 "No es tu turno" (Liliana no es firmante)', async () => {
    const ctx = await atPlaneacion();
    const attempt = ctx.service.approve(
      LILIANA,
      'bud-compras',
      seen(ctx, 'bud-compras'),
    );
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    await expect(attempt).rejects.toThrow(
      'No es tu turno: Lo firma el firmante de planeación',
    );
  });

  it('David y Laura deciden distinto al mismo tiempo: al segundo le dice qué pasó (409), no "ya hecho"', async () => {
    const ctx = await atPlaneacion();
    const screenOfDavid = seen(ctx, 'bud-compras');
    await ctx.service.approve(LAURA, 'bud-compras', seen(ctx, 'bud-compras'));
    const attempt = ctx.service.reject(DAVID, 'bud-compras', {
      ...screenOfDavid,
      comment: 'No cuadra con lo que platicamos',
    });
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(/Laura aprobó el paso de planeación/);
    expect(ctx.store.events).toHaveLength(3);
  });

  it('un reintento de la misma persona con la misma acción cuenta como ya hecho', async () => {
    const ctx = await atPlaneacion();
    const screen = seen(ctx, 'bud-compras');
    await ctx.service.approve(DAVID, 'bud-compras', screen);
    const f = await ctx.service.approve(DAVID, 'bud-compras', screen);
    expect(ctx.store.events).toHaveLength(3);
    expect(f.budget.status).toBe('aprobado_planeacion');
  });

  it('cada paso bloquea primero la versión (FOR SHARE) y después el presupuesto (FOR UPDATE)', async () => {
    const ctx = setup();
    await ctx.service.submit(DIANA, 'bud-compras', seen(ctx, 'bud-compras'));
    const sql = ctx.prisma.$queryRaw.mock.calls.map((c) => c[0].join('?'));
    expect(sql[0]).toContain('FROM fpa_versions');
    expect(sql[0]).toContain('FOR SHARE');
    expect(sql[1]).toContain('FROM fpa_budgets');
    expect(sql[1]).toContain('FOR UPDATE');
  });

  it('rechazar sin decir por qué no pasa (400)', async () => {
    const ctx = await atPlaneacion();
    await expect(
      ctx.service.reject(
        DAVID,
        'bud-compras',
        seen(ctx, 'bud-compras', 'corto'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no se envía sin líneas, con una "No disponible" ni por quien no captura', async () => {
    const ctx = setup();
    ctx.store.photos['bud-compras'].unavailable = true;
    await expect(
      ctx.service.submit(DIANA, 'bud-compras', seen(ctx, 'bud-compras')),
    ).rejects.toThrow(/No disponible/);
    ctx.store.photos['bud-compras'] = {
      total: '0.00',
      lines: [],
      unavailable: false,
    };
    await expect(
      ctx.service.submit(DIANA, 'bud-compras', seen(ctx, 'bud-compras')),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      ctx.service.submit(INGRID, 'bud-compras', seen(ctx, 'bud-compras')),
    ).rejects.toThrow('Solo quien captura el área lo envía');
    expect(ctx.store.events).toHaveLength(0);
  });

  it('retirar antes de la primera firma lo regresa a borrador; el reenvío abre la ronda 2', async () => {
    const ctx = setup();
    await ctx.service.submit(DIANA, 'bud-compras', seen(ctx, 'bud-compras'));
    expect(await ctx.service.pending(INGRID)).toHaveLength(1);
    await ctx.service.withdraw(DIANA, 'bud-compras', seen(ctx, 'bud-compras'));
    expect(budget(ctx)).toMatchObject({ status: 'borrador', current_round: 1 });
    expect(await ctx.service.pending(INGRID)).toHaveLength(0);
    expect(screens(ctx).slice(-1)).toEqual(['ingrid']);
    await ctx.service.submit(DIANA, 'bud-compras', seen(ctx, 'bud-compras'));
    expect(budget(ctx)).toMatchObject({ status: 'enviado', current_round: 2 });
  });

  it('planeación reabre un aprobado con comentario: regresa a captura sin fecha de aprobación', async () => {
    const ctx = setup();
    for (const who of [DIANA, INGRID, DAVID, URIEL]) {
      const act = who === DIANA ? 'submit' : 'approve';
      await ctx.service[act](who, 'bud-compras', seen(ctx, 'bud-compras'));
    }
    expect(budget(ctx).status).toBe('aprobado_cfo');
    await ctx.service.reopen(
      LILIANA,
      'bud-compras',
      seen(ctx, 'bud-compras', 'Cambió el tipo de cambio de Santander'),
    );
    expect(budget(ctx)).toMatchObject({
      status: 'devuelto',
      approved_at: null,
    });
    expect(emails(ctx).slice(-1)[0]).toMatchObject({
      template: 'fpa_reabierto',
      to: { email: 'diana@abent3t.com' },
    });
  });
});

describe('FpaFlowService — la bandeja y el turno sin salida', () => {
  it('cada quien ve lo suyo: firmas para quien tiene el turno, devueltos para quien captura; soporte no', async () => {
    const ctx = setup();
    await ctx.service.submit(DIANA, 'bud-compras', seen(ctx, 'bud-compras'));
    expect(await ctx.service.pending(INGRID)).toEqual([
      expect.objectContaining({
        budget_id: 'bud-compras',
        kind: 'firma',
        step: 'area',
        total_mxn: '340000.00',
        sender: { id: 'diana', full_name: 'Diana' },
      }),
    ]);
    expect(await ctx.service.pending(ALEX)).toEqual([]);
    expect(await ctx.service.pending(DIANA)).toEqual([]);
    await ctx.service.reject(
      INGRID,
      'bud-compras',
      seen(ctx, 'bud-compras', 'Faltan los viajes de noviembre'),
    );
    const mine = await ctx.service.pending(JORGE);
    expect(mine).toEqual([
      expect.objectContaining({
        kind: 'devuelto',
        last: expect.objectContaining({
          action: 'rechazado',
          comment: 'Faltan los viajes de noviembre',
        }) as unknown,
      }),
    ]);
  });

  it('DG: David aprueba el área y Laura la envió; nadie de los firmantes puede firmar planeación', async () => {
    const ctx = setup();
    await ctx.service.submit(LAURA, 'bud-dg', seen(ctx, 'bud-dg'));
    await ctx.service.approve(DAVID, 'bud-dg', seen(ctx, 'bud-dg'));
    const f = await ctx.service.flow(LILIANA, 'bud-dg');
    expect(f.turn).toMatchObject({
      step: 'planeacion',
      who: [],
      blocked: true,
    });
    expect(await ctx.service.pending(DAVID)).toEqual([]);
    expect(await ctx.service.pending(LAURA)).toEqual([]);
  });

  it('el flujo de un área solo lo ve quien tiene algo en ella, o quien ve todo', async () => {
    const ctx = setup();
    await expect(ctx.service.flow(INGRID, 'bud-dg')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(ctx.service.flow(URIEL, 'bud-dg')).resolves.toMatchObject({
      budget: { id: 'bud-dg' },
    });
  });
});

describe('FpaFlowService — recordatorio diario', () => {
  it('a los 3 días hábiles le recuerda a quien tiene el turno; a los 2, no; en fin de semana, nada', async () => {
    const ctx = setup();
    await ctx.service.submit(DIANA, 'bud-compras', seen(ctx, 'bud-compras'));
    // El envío fue el lunes 2-nov (CDMX)
    ctx.store.events[0].created_at = new Date('2026-11-02T17:00:00Z');
    ctx.email.enqueue.mockClear();

    // Miércoles 4-nov: 2 días hábiles (martes y miércoles)
    let r = await ctx.service.runReminderCheck(
      new Date('2026-11-04T14:25:00Z'),
    );
    expect(r).toMatchObject({ checked: 1, reminded: 0 });

    // Jueves 5-nov: 3 días hábiles
    r = await ctx.service.runReminderCheck(new Date('2026-11-05T14:25:00Z'));
    expect(r).toMatchObject({ reminded: 1, errors: [] });
    expect(emails(ctx)).toEqual([
      expect.objectContaining({
        template: 'fpa_recordatorio',
        entityId: 'bud-compras:r1:area',
        to: expect.objectContaining({ email: 'ingrid@abent3t.com' }) as unknown,
      }),
    ]);

    // Sábado 7-nov: no sale nada
    ctx.email.enqueue.mockClear();
    r = await ctx.service.runReminderCheck(new Date('2026-11-07T14:25:00Z'));
    expect(r.checked).toBe(0);
    expect(emails(ctx)).toEqual([]);
  });
});
