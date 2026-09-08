import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { EmailService } from '../email/email.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  isoWeek,
  PurchaseCommitteesService,
} from './purchase-committees.service';

/**
 * Fase §16. Motor de aprobación probado con Prisma EN MEMORIA — cero red,
 * cero BD. La cadena se lee de committee_approval_levels simulada, así que
 * los tests demuestran el criterio clave: cambiar el mapeo altera quién puede
 * aprobar SIN cambios de código.
 */

type Row = Record<string, unknown> & { id: string };

let idSeq = 0;
const nextId = () =>
  `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;

const asUser = (id: string, roles: string[]): AuthUser =>
  ({
    id,
    email: `${id}@abent3t.com`,
    full_name: id,
    role: roles[0] ?? 'colaborador',
    roles,
    role_assignments: [],
    department_id: null,
    is_active: true,
  }) as AuthUser;

const AUTHOR = asUser('autor-1', ['coordinador_compras']);
const INGRID = asUser('ingrid', ['lider_procura']);
const GILBERTO = asUser('gilberto', ['aprobador_nivel_1']);
const ALEJANDRO = asUser('alejandro', ['aprobador_nivel_2']);
const URIEL = asUser('uriel', ['aprobador_nivel_3']);
const FELIX = asUser('felix', ['director_general']);
const CHAIN_USERS = [INGRID, GILBERTO, ALEJANDRO, URIEL, FELIX];

function defaultLevels(): Row[] {
  return [
    {
      id: nextId(),
      orden: 1,
      role: 'lider_procura',
      profile_id: null,
      confirmed: false,
      is_active: true,
      notes: null,
    },
    {
      id: nextId(),
      orden: 2,
      role: 'aprobador_nivel_1',
      profile_id: null,
      confirmed: false,
      is_active: true,
      notes: null,
    },
    {
      id: nextId(),
      orden: 3,
      role: 'aprobador_nivel_2',
      profile_id: null,
      confirmed: false,
      is_active: true,
      notes: null,
    },
    {
      id: nextId(),
      orden: 4,
      role: 'aprobador_nivel_3',
      profile_id: null,
      confirmed: false,
      is_active: true,
      notes: null,
    },
    {
      id: nextId(),
      orden: 5,
      role: 'director_general',
      profile_id: null,
      confirmed: false,
      is_active: true,
      notes: null,
    },
  ];
}

function makeHarness(levels: Row[] = defaultLevels()) {
  const committees: Row[] = [];
  const versions: Row[] = [];
  const approvals: Row[] = [];
  const emails: Array<{ to: string; subject: string }> = [];

  const withAuthor = (row: Row) => ({
    ...row,
    profiles: {
      id: row.created_by,
      full_name: String(row.created_by),
      email: `${String(row.created_by)}@abent3t.com`,
    },
  });

  const committeeTable = {
    count: jest.fn(() => Promise.resolve(committees.length)),
    findMany: jest.fn(({ where }: { where?: Record<string, unknown> } = {}) =>
      Promise.resolve(
        committees
          .filter((c) => {
            if (where?.status && c.status !== where.status) return false;
            const levelIn = (
              where?.current_approver_level as { in?: number[] } | undefined
            )?.in;
            if (
              levelIn &&
              !levelIn.includes(c.current_approver_level as number)
            )
              return false;
            return true;
          })
          .map(withAuthor),
      ),
    ),
    findFirst: jest.fn(({ where }: { where: { id?: string } }) => {
      const found = committees.find((c) => c.id === where.id);
      return Promise.resolve(found ? withAuthor(found) : null);
    }),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const row: Row = {
        id: nextId(),
        status: 'borrador',
        current_version: 1,
        current_approver_level: null,
        submitted_at: null,
        approved_at: null,
        total_elapsed_hours: null,
        is_active: true,
        ...data,
      };
      committees.push(row);
      return Promise.resolve(withAuthor(row));
    }),
    update: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = committees.find((c) => c.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(withAuthor(row));
      },
    ),
  };

  const versionTable = {
    findFirst: jest.fn(
      ({ where }: { where: { committee_id: string; version?: number } }) =>
        Promise.resolve(
          versions.find(
            (v) =>
              v.committee_id === where.committee_id &&
              (where.version === undefined || v.version === where.version),
          ) ?? null,
        ),
    ),
    findMany: jest.fn(() => Promise.resolve([...versions])),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const row: Row = { id: nextId(), ...data };
      versions.push(row);
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
        const row = versions.find((v) => v.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
    ),
  };

  const approvalTable = {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const duplicate = approvals.some(
        (a) =>
          a.committee_id === data.committee_id &&
          a.version === data.version &&
          a.approver_level === data.approver_level,
      );
      if (duplicate) {
        return Promise.reject(
          Object.assign(new Error('unique'), { code: 'P2002' }),
        );
      }
      const row: Row = { id: nextId(), action_at: new Date(), ...data };
      approvals.push(row);
      return Promise.resolve(row);
    }),
    findFirst: jest.fn(
      ({ where }: { where: { committee_id: string; version?: number } }) => {
        const rows = approvals.filter(
          (a) =>
            a.committee_id === where.committee_id &&
            (where.version === undefined || a.version === where.version),
        );
        return Promise.resolve(rows[rows.length - 1] ?? null);
      },
    ),
    findMany: jest.fn(({ where }: { where?: { committee_id?: string } } = {}) =>
      Promise.resolve(
        approvals
          .filter(
            (a) =>
              !where?.committee_id || a.committee_id === where.committee_id,
          )
          .map((a) => ({
            ...a,
            profiles: {
              id: a.approver_profile_id,
              full_name: String(a.approver_profile_id),
              email: `${String(a.approver_profile_id)}@abent3t.com`,
            },
          })),
      ),
    ),
  };

  const prisma = {
    purchase_committees: committeeTable,
    committee_versions: versionTable,
    committee_approvals: approvalTable,
    committee_approval_levels: {
      findMany: jest.fn(({ where }: { where?: { is_active?: boolean } } = {}) =>
        Promise.resolve(
          levels
            .filter((l) => where?.is_active === undefined || l.is_active)
            .sort((a, b) => (a.orden as number) - (b.orden as number)),
        ),
      ),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(levels.find((l) => l.id === where.id) ?? null),
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = levels.find((l) => l.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
    },
    profiles: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        // Destinatarios por rol (fake: usuarios de la cadena + autor)
        const all = [AUTHOR, ...CHAIN_USERS];
        const byId = (where.id as string | undefined) ?? null;
        if (byId) {
          const u = all.find((x) => x.id === byId);
          return Promise.resolve(
            u ? [{ email: u.email, full_name: u.full_name }] : [],
          );
        }
        const or = (where.OR as Array<Record<string, unknown>>) ?? [];
        const role = (or[1]?.role ?? null) as string | null;
        return Promise.resolve(
          all
            .filter((u) => role !== null && u.roles.includes(role))
            .map((u) => ({ email: u.email, full_name: u.full_name })),
        );
      }),
      findFirst: jest.fn(() => Promise.resolve({ id: 'p-1' })),
    },
    $transaction: jest.fn(),
  };
  // Implementación después de construir el objeto para no crear inferencia
  // circular (prisma quedaría tipado any).
  prisma.$transaction.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );

  const storage = {
    bucketCommittees: 'purchase-committees',
    upload: jest.fn().mockResolvedValue({ path: 'x' }),
    getSignedUrl: jest.fn().mockResolvedValue('https://minio/firmada'),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const email = {
    sendEmail: jest.fn(
      ({ to, subject }: { to: { email: string }; subject: string }) => {
        emails.push({ to: to.email, subject });
        return Promise.resolve({ success: true, messageId: 'sim' });
      },
    ),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  const service = new PurchaseCommitteesService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    email as unknown as EmailService,
    audit as unknown as AuditService,
  );
  return {
    service,
    prisma,
    storage,
    email,
    audit,
    committees,
    versions,
    approvals,
    emails,
    levels,
  };
}

/** Alta + documento (link) listo para enviar. */
async function draftWithDocument(h: ReturnType<typeof makeHarness>) {
  const created = await h.service.create(
    { committee_date: '2026-09-03', title: 'Comité semanal' },
    AUTHOR,
  );
  await h.service.uploadVersion(
    created.id,
    AUTHOR,
    undefined,
    'https://slides.example.com/comite',
  );
  return created;
}

const pptx = (overrides: Partial<Express.Multer.File> = {}) =>
  ({
    originalname: 'comite.pptx',
    mimetype:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 2048,
    buffer: Buffer.from('PK'),
    ...overrides,
  }) as Express.Multer.File;

describe('PurchaseCommitteesService — motor de aprobación (§16)', () => {
  it('flujo completo: los 5 niveles del seed aprueban en orden y el comité queda aprobado', async () => {
    const h = makeHarness();
    const committee = await draftWithDocument(h);
    expect(committee.committee_number).toMatch(/^COM-2026-W\d{2}$/);

    await h.service.submit(committee.id, AUTHOR);
    let state = h.committees[0];
    expect(state.status).toBe('en_aprobacion');
    expect(state.current_approver_level).toBe(1);
    // El primer nivel fue notificado
    expect(h.emails.some((e) => e.to === INGRID.email)).toBe(true);

    for (const approver of CHAIN_USERS) {
      await h.service.approve(committee.id, approver, { ip: '10.0.0.1' });
    }
    state = h.committees[0];
    expect(state.status).toBe('aprobado');
    expect(state.current_approver_level).toBeNull();
    expect(state.approved_at).toBeInstanceOf(Date);
    expect(h.approvals).toHaveLength(5);
    expect(h.approvals.map((a) => a.approver_level)).toEqual([1, 2, 3, 4, 5]);
    expect(h.approvals.every((a) => a.action === 'aprobado')).toBe(true);
    // Resolución notificada al autor
    expect(
      h.emails.some(
        (e) => e.to === AUTHOR.email && e.subject.includes('APROBADO'),
      ),
    ).toBe(true);
    // Auditoría: create + upload + submit(update) + 5 approve
    expect(h.audit.log).toHaveBeenCalledTimes(8);
  });

  it('rechazo en nivel intermedio termina el flujo, exige justificación y notifica al autor', async () => {
    const h = makeHarness();
    const committee = await draftWithDocument(h);
    await h.service.submit(committee.id, AUTHOR);
    await h.service.approve(committee.id, INGRID, {});

    await h.service.reject(
      committee.id,
      { justification: 'Presupuesto sin soporte suficiente' },
      GILBERTO,
      { ip: '10.0.0.2' },
    );
    const state = h.committees[0];
    expect(state.status).toBe('rechazado');
    expect(state.current_approver_level).toBeNull();
    const rejection = h.approvals.find((a) => a.action === 'rechazado')!;
    expect(rejection.approver_level).toBe(2);
    expect(rejection.justification).toContain('Presupuesto');
    expect(
      h.emails.some(
        (e) => e.to === AUTHOR.email && e.subject.includes('rechazado'),
      ),
    ).toBe(true);

    // Nadie puede seguir aprobando un comité rechazado
    await expect(
      h.service.approve(committee.id, ALEJANDRO, {}),
    ).rejects.toThrow(BadRequestException);
  });

  it('aprobar fuera de turno → 403 "No es tu turno de aprobar" (enforce en service)', async () => {
    const h = makeHarness();
    const committee = await draftWithDocument(h);
    await h.service.submit(committee.id, AUTHOR);

    await expect(h.service.approve(committee.id, URIEL, {})).rejects.toThrow(
      ForbiddenException,
    );
    await expect(h.service.approve(committee.id, URIEL, {})).rejects.toThrow(
      'No es tu turno de aprobar',
    );
    expect(h.approvals).toHaveLength(0);
  });

  it('doble aprobación del mismo (versión, nivel) → idempotente vía P2002', async () => {
    const h = makeHarness();
    const committee = await draftWithDocument(h);
    await h.service.submit(committee.id, AUTHOR);
    // Estado de carrera: ya existe la firma del nivel 1 pero el comité aún
    // apunta al nivel 1 (réplica concurrente del request)
    h.approvals.push({
      id: nextId(),
      committee_id: committee.id,
      version: 1,
      approver_level: 1,
      approver_profile_id: INGRID.id,
      action: 'aprobado',
      action_at: new Date(),
    });

    const result = await h.service.approve(committee.id, INGRID, {});
    expect(result).toBeDefined(); // no lanza
    expect(h.approvals).toHaveLength(1); // no duplicó la firma
    expect(h.committees[0].current_approver_level).toBe(1); // no avanzó dos veces
  });

  it('cambiar el mapeo en committee_approval_levels altera quién aprueba SIN código', async () => {
    const levels = defaultLevels();
    const h = makeHarness(levels);
    const committee = await draftWithDocument(h);
    await h.service.submit(committee.id, AUTHOR);
    await h.service.approve(committee.id, INGRID, {});

    // "Gilberto → David": el nivel 2 pasa a un USUARIO específico
    levels[1].profile_id = 'david';
    await expect(h.service.approve(committee.id, GILBERTO, {})).rejects.toThrow(
      ForbiddenException,
    );
    // Y la cadena se puede ACORTAR antes de que esos niveles entren en turno:
    // con 3 y 4 desactivados, el siguiente después del 2 es Félix (5)
    levels[2].is_active = false;
    levels[3].is_active = false;
    const david = asUser('david', ['aprobador_nivel_1']);
    await h.service.approve(committee.id, david, {});
    expect(h.committees[0].current_approver_level).toBe(5);

    await expect(
      h.service.approve(committee.id, ALEJANDRO, {}),
    ).rejects.toThrow(ForbiddenException);
    await h.service.approve(committee.id, FELIX, {});
    expect(h.committees[0].status).toBe('aprobado');
  });

  it('submit exige el documento de la versión y el reenvío tras rechazo sube de versión', async () => {
    const h = makeHarness();
    const created = await h.service.create(
      { committee_date: '2026-09-03', title: 'Sin documento' },
      AUTHOR,
    );
    await expect(h.service.submit(created.id, AUTHOR)).rejects.toThrow(
      'Sube el documento de la versión 1',
    );

    await h.service.uploadVersion(created.id, AUTHOR, pptx());
    await h.service.submit(created.id, AUTHOR);
    await h.service.reject(
      created.id,
      { justification: 'Corrige la agenda por favor' },
      INGRID,
      {},
    );

    // Reenvío sin la v2 → bloqueado; con v2 → current_version=2 y nivel 1
    await expect(h.service.submit(created.id, AUTHOR)).rejects.toThrow(
      'Sube el documento de la versión 2',
    );
    await h.service.uploadVersion(
      created.id,
      AUTHOR,
      undefined,
      'https://slides.example.com/v2',
    );
    await h.service.submit(created.id, AUTHOR);
    const state = h.committees[0];
    expect(state.status).toBe('en_aprobacion');
    expect(state.current_version).toBe(2);
    expect(state.current_approver_level).toBe(1);
    expect(h.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it('uploadVersion valida formato (.pdf/.pptx), 30MB y archivo XOR link', async () => {
    const h = makeHarness();
    const created = await h.service.create(
      { committee_date: '2026-09-03', title: 'Validaciones' },
      AUTHOR,
    );
    await expect(
      h.service.uploadVersion(created.id, AUTHOR, undefined, undefined),
    ).rejects.toThrow('Adjunta un archivo');
    await expect(
      h.service.uploadVersion(
        created.id,
        AUTHOR,
        pptx(),
        'https://link.example.com',
      ),
    ).rejects.toThrow('no ambos');
    await expect(
      h.service.uploadVersion(
        created.id,
        AUTHOR,
        pptx({ mimetype: 'image/png' }),
      ),
    ).rejects.toThrow('Solo .pdf o .pptx');
    await expect(
      h.service.uploadVersion(
        created.id,
        AUTHOR,
        pptx({ size: 31 * 1024 * 1024 }),
      ),
    ).rejects.toThrow('30MB');
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it('recordatorio: >48h en el mismo nivel → correo al aprobador del turno; <48h no', async () => {
    const h = makeHarness();
    const committee = await draftWithDocument(h);
    await h.service.submit(committee.id, AUTHOR);
    h.emails.length = 0;

    // 50 horas después de enviarse, sin acciones
    const now = new Date(
      (h.committees[0].submitted_at as Date).getTime() + 50 * 3_600_000,
    );
    const late = await h.service.runReminderCheck(now);
    expect(late.reminded).toBe(1);
    expect(
      h.emails.some(
        (e) => e.to === INGRID.email && e.subject.includes('Recordatorio'),
      ),
    ).toBe(true);

    h.emails.length = 0;
    const early = await h.service.runReminderCheck(
      new Date(
        (h.committees[0].submitted_at as Date).getTime() + 10 * 3_600_000,
      ),
    );
    expect(early.reminded).toBe(0);
    expect(h.emails).toHaveLength(0);
  });

  it('pendientes/me filtra por el turno del usuario', async () => {
    const h = makeHarness();
    const committee = await draftWithDocument(h);
    await h.service.submit(committee.id, AUTHOR);

    expect(await h.service.pendingForMe(INGRID)).toHaveLength(1);
    expect(await h.service.pendingForMe(FELIX)).toHaveLength(0);

    await h.service.approve(committee.id, INGRID, {});
    expect(await h.service.pendingForMe(INGRID)).toHaveLength(0);
    expect(await h.service.pendingForMe(GILBERTO)).toHaveLength(1);
  });
});

describe('isoWeek', () => {
  it('calcula la semana ISO del consecutivo COM-YYYY-WNN', () => {
    expect(isoWeek(new Date('2026-01-01'))).toEqual({ year: 2026, week: 1 });
    expect(isoWeek(new Date('2026-09-03'))).toEqual({ year: 2026, week: 36 });
    // El 1-ene-2027 (viernes) pertenece a la semana 53 de 2026
    expect(isoWeek(new Date('2027-01-01'))).toEqual({ year: 2026, week: 53 });
  });
});
