import { PrismaService } from '../prisma/prisma.service';
import {
  PurchaseUsersService,
  SQL_FOLD_FROM,
  SQL_FOLD_TO,
  escapeLikePattern,
  normalizeSearchTokens,
} from './purchase-users.service';

/** Fase §16 (T7). Prisma simulado — sin BD. */

function makeService(rows: Array<Record<string, unknown>>) {
  const prisma = {
    profiles: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  const service = new PurchaseUsersService(prisma as unknown as PrismaService);
  return { service, prisma };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'p-1',
  full_name: 'Comprador Uno',
  email: 'comprador@abent3t.com',
  role: 'colaborador', // primario legado de otro módulo
  department_id: 'd-1', // NO debe salir en la respuesta
  is_active: true,
  user_roles_user_roles_profile_idToprofiles: [{ role: 'comprador' }],
  ...overrides,
});

describe('PurchaseUsersService (T7)', () => {
  it('devuelve SOLO id/full_name/email/role, con el rol de compras asignado', async () => {
    const { service } = makeService([row()]);
    const result = await service.findAll();
    expect(result).toEqual([
      {
        id: 'p-1',
        full_name: 'Comprador Uno',
        email: 'comprador@abent3t.com',
        role: 'comprador',
      },
    ]);
    // Nada sensible se filtra
    expect(Object.keys(result[0]).sort()).toEqual([
      'email',
      'full_name',
      'id',
      'role',
    ]);
  });

  it('?role= filtra contra la allowlist y viaja al where de Prisma', async () => {
    const { service, prisma } = makeService([row()]);
    await service.findAll('comprador');
    const args = (
      prisma.profiles.findMany.mock.calls[0] as [
        { where: { OR: Array<Record<string, unknown>> } },
      ]
    )[0];
    expect(JSON.stringify(args.where)).toContain('"comprador"');
    expect(JSON.stringify(args.where)).not.toContain('aprobador_nivel_1');
  });

  it('rol fuera de la allowlist → lista vacía sin tocar la BD', async () => {
    const { service, prisma } = makeService([row()]);
    const result = await service.findAll('super_admin');
    expect(result).toEqual([]);
    expect(prisma.profiles.findMany).not.toHaveBeenCalled();
  });

  it('cae al rol primario legado si no hay asignación en user_roles', async () => {
    const { service } = makeService([
      row({
        role: 'director_general',
        user_roles_user_roles_profile_idToprofiles: [],
      }),
    ]);
    const result = await service.findAll();
    expect(result[0].role).toBe('director_general');
  });
});

/**
 * Gestion de roles de Compras (autoservicio 2026-09): listado de TODOS los
 * perfiles activos con sus roles de compras, busqueda y meta estandar.
 */
describe('PurchaseUsersService.findAllForRoleManagement', () => {
  const count = jest.fn();
  const findMany = jest.fn();
  const queryRaw = jest.fn();
  const prisma = {
    profiles: { count, findMany },
    $queryRaw: queryRaw,
  } as unknown as PrismaService;
  const service = new PurchaseUsersService(prisma);

  type FindManyArgs = {
    where: Record<string, unknown>;
    select: {
      user_roles_user_roles_profile_idToprofiles: {
        where: Record<string, unknown>;
      };
    };
    orderBy?: unknown;
    skip?: number;
    take?: number;
  };
  const findManyArgs = () => (findMany.mock.calls[0] as [FindManyArgs])[0];
  /** Prisma.sql que recibió $queryRaw: texto y parámetros viajan aparte. */
  const rawSql = () =>
    (queryRaw.mock.calls[0] as [{ strings: string[]; values: unknown[] }])[0];

  const profileRow = (id: string, full_name: string, email: string) => ({
    id,
    full_name,
    email,
    position: null,
    departments: null,
    user_roles_user_roles_profile_idToprofiles: [],
  });

  beforeEach(() => {
    count.mockReset();
    findMany.mockReset();
    queryRaw.mockReset();
  });

  it('lista perfiles activos con sus roles de compras y meta estándar', async () => {
    count.mockResolvedValue(42);
    findMany.mockResolvedValue([
      {
        id: 'u1',
        full_name: 'Ana López',
        email: 'ana@abent3t.com',
        position: 'Analista',
        departments: { name: 'Procura' },
        user_roles_user_roles_profile_idToprofiles: [
          { role: 'comprador' },
          { role: 'solicitante' },
        ],
      },
      {
        id: 'u2',
        full_name: 'Beto Ruiz',
        email: 'beto@abent3t.com',
        position: null,
        departments: null,
        user_roles_user_roles_profile_idToprofiles: [],
      },
    ]);

    const result = await service.findAllForRoleManagement(2, 20);

    expect(result.data).toEqual([
      {
        id: 'u1',
        full_name: 'Ana López',
        email: 'ana@abent3t.com',
        position: 'Analista',
        department: 'Procura',
        purchase_roles: ['comprador', 'solicitante'],
      },
      {
        id: 'u2',
        full_name: 'Beto Ruiz',
        email: 'beto@abent3t.com',
        position: null,
        department: null,
        purchase_roles: [],
      },
    ]);
    expect(result.meta).toEqual({
      total: 42,
      page: 2,
      limit: 20,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });

    // Solo perfiles ACTIVOS y solo roles de compras vigentes.
    const args = (
      findMany.mock.calls[0] as [
        {
          where: { is_active: boolean };
          select: {
            user_roles_user_roles_profile_idToprofiles: {
              where: { is_active: boolean; module: string };
            };
          };
          skip: number;
          take: number;
        },
      ]
    )[0];
    expect(args.where.is_active).toBe(true);
    expect(
      args.select.user_roles_user_roles_profile_idToprofiles.where,
    ).toEqual({ is_active: true, module: 'compras' });
    expect(args.skip).toBe(20);
    expect(args.take).toBe(20);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it.each<string | undefined>([undefined, '', '   ', ' @.- '])(
    'sin término útil (%p) conserva el camino de Prisma, sin SQL crudo',
    async (search) => {
      count.mockResolvedValue(0);
      findMany.mockResolvedValue([]);

      await service.findAllForRoleManagement(1, 20, search);

      expect(queryRaw).not.toHaveBeenCalled();
      expect(count).toHaveBeenCalledWith({ where: { is_active: true } });
      expect(findManyArgs().where).toEqual({ is_active: true });
      expect(findManyArgs().orderBy).toEqual({ full_name: 'asc' });
    },
  );

  it('G4: con término, cada palabra va plegada (sin acentos ni mayúsculas) como parámetro LIKE sobre nombre O correo', async () => {
    queryRaw.mockResolvedValue([{ id: null, total: 0 }]);

    await service.findAllForRoleManagement(1, 20, '  González   JORGE ');

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const { strings, values } = rawSql();
    const text = strings.join('?');
    // Las palabras (en cualquier orden) viajan como parámetros, ya plegadas…
    expect(values).toContain('%gonzalez%');
    expect(values).toContain('%jorge%');
    // …una vez para el nombre y otra para el correo (OR) de cada palabra
    expect(values.filter((v) => v === '%gonzalez%')).toHaveLength(2);
    expect(values.filter((v) => v === '%jorge%')).toHaveLength(2);
    expect(text.match(/f\.name_key LIKE \? ESCAPE/g)).toHaveLength(2);
    expect(text.match(/f\.email_key LIKE \? ESCAPE/g)).toHaveLength(2);
    // …y nunca se interpolan en el texto del SQL
    expect(text).not.toMatch(/gonz|jorge/i);
    // Columnas plegadas en SQL con el mismo mapa; solo perfiles activos
    expect(text).toContain('translate(lower(coalesce(p.full_name');
    expect(text).toContain('translate(lower(p.email)');
    expect(values).toContain(SQL_FOLD_FROM);
    expect(values).toContain(SQL_FOLD_TO);
    expect(text).toContain('p.is_active = true');
    expect(text).toContain('ORDER BY full_name NULLS LAST, email');
    // El total sale del mismo SQL: ni count de Prisma ni lectura de filas
    expect(count).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('G4: con término, pagina en SQL y responde la forma de siempre en el orden del SQL', async () => {
    queryRaw.mockResolvedValue([
      { id: 'u2', total: 23 },
      { id: 'u1', total: 23 },
    ]);
    // Prisma no garantiza el orden de `id IN (…)`: se reordena al del SQL
    findMany.mockResolvedValue([
      {
        ...profileRow('u1', 'Diego Ramírez', 'dramirez@proveedor.com'),
        position: 'Comprador',
        departments: { name: 'Procura' },
        user_roles_user_roles_profile_idToprofiles: [{ role: 'comprador' }],
      },
      profileRow('u2', 'Ana Ramírez', 'aramirez@proveedor.com'),
    ]);

    const result = await service.findAllForRoleManagement(2, 20, 'ramirez');

    // LIMIT y OFFSET también son parámetros
    expect(rawSql().values.slice(-2)).toEqual([20, 20]);
    const args = findManyArgs();
    expect(args.where).toEqual({ id: { in: ['u2', 'u1'] } });
    expect(
      args.select.user_roles_user_roles_profile_idToprofiles.where,
    ).toEqual({ is_active: true, module: 'compras' });
    expect(result).toEqual({
      data: [
        {
          id: 'u2',
          full_name: 'Ana Ramírez',
          email: 'aramirez@proveedor.com',
          position: null,
          department: null,
          purchase_roles: [],
        },
        {
          id: 'u1',
          full_name: 'Diego Ramírez',
          email: 'dramirez@proveedor.com',
          position: 'Comprador',
          department: 'Procura',
          purchase_roles: ['comprador'],
        },
      ],
      meta: {
        total: 23,
        page: 2,
        limit: 20,
        totalPages: 2,
        hasNext: false,
        hasPrev: true,
      },
    });
  });

  it('G4: página fuera de rango → sin filas pero con el total real', async () => {
    queryRaw.mockResolvedValue([{ id: null, total: 3 }]);

    const result = await service.findAllForRoleManagement(5, 20, 'ana');

    expect(findMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      data: [],
      meta: {
        total: 3,
        page: 5,
        limit: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: true,
      },
    });
  });

  it('sin resultados: totalPages mínimo 1 y sin páginas vecinas', async () => {
    queryRaw.mockResolvedValue([{ id: null, total: 0 }]);

    const result = await service.findAllForRoleManagement(1, 20, 'nadie');
    expect(result.meta).toEqual({
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    });
  });
});

/** G4 (junta 2026-09-28): búsqueda de personas sin acentos y por palabras. */
describe('normalizeSearchTokens', () => {
  it.each<[string, string[]]>([
    ['jorge gonzalez', ['jorge', 'gonzalez']],
    ['González Jorge', ['gonzalez', 'jorge']],
    ['GONZALEZ', ['gonzalez']],
    ['jorge.gonzalez@', ['jorge', 'gonzalez']],
    ['jgonzalez@proveedor.com', ['jgonzalez', 'proveedor', 'com']],
    ['  NÚÑEZ-Pérez,   Ma. Ángeles ', ['nunez', 'perez', 'ma', 'angeles']],
    ['ana ANA Ána', ['ana']],
    ['González', ['gonzalez']], // acento combinado (NFD, p. ej. macOS)
    ['E041', ['e041']],
  ])('%p → %p', (term, expected) => {
    expect(normalizeSearchTokens(term)).toEqual(expected);
  });

  it.each<string | null | undefined>([undefined, null, '', '   ', '@.-_%'])(
    '%p → sin búsqueda',
    (term) => {
      expect(normalizeSearchTokens(term)).toEqual([]);
    },
  );

  it('pliega igual que el translate() del SQL (mismo mapa, mayúsculas incluidas)', () => {
    // translate() BORRA los caracteres sin pareja: las longitudes deben casar
    expect(SQL_FOLD_FROM).toHaveLength(SQL_FOLD_TO.length);
    expect(normalizeSearchTokens(SQL_FOLD_FROM)).toEqual([SQL_FOLD_TO]);
  });
});

describe('escapeLikePattern', () => {
  it('escapa %, _ y \\ para que LIKE los tome literales', () => {
    expect(escapeLikePattern('50%_a\\b')).toBe('50\\%\\_a\\\\b');
    expect(escapeLikePattern('gonzalez')).toBe('gonzalez');
  });
});
