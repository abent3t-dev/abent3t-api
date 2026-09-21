import { PrismaService } from '../prisma/prisma.service';
import { PurchaseUsersService } from './purchase-users.service';

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
  const prisma = { profiles: { count, findMany } } as unknown as PrismaService;
  const service = new PurchaseUsersService(prisma);

  beforeEach(() => {
    count.mockReset();
    findMany.mockReset();
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
  });

  it('aplica la búsqueda por nombre o email (insensitive)', async () => {
    count.mockResolvedValue(0);
    findMany.mockResolvedValue([]);

    await service.findAllForRoleManagement(1, 20, '  ingrid ');

    const where = (findMany.mock.calls[0] as [{ where: { OR: unknown } }])[0]
      .where;
    expect(where.OR).toEqual([
      { full_name: { contains: 'ingrid', mode: 'insensitive' } },
      { email: { contains: 'ingrid', mode: 'insensitive' } },
    ]);
  });

  it('sin resultados: totalPages mínimo 1 y sin páginas vecinas', async () => {
    count.mockResolvedValue(0);
    findMany.mockResolvedValue([]);

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
