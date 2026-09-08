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
