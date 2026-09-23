import { PrismaService } from '../prisma/prisma.service';
import { ErpAliasesService } from './erp-aliases.service';

/**
 * Bloque 2026-09-23 (D6). Prisma en memoria: resolución de códigos (sin
 * distinguir mayúsculas, con caché por sistema), importación CSV con
 * encabezados en español y sistema por defecto, y perfil ligado por email.
 */

type Row = {
  id: string;
  system: string;
  code: string;
  display_name: string;
  profile_id: string | null;
  is_active: boolean;
};

function makeHarness(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  let seq = 0;
  const prisma = {
    erp_user_aliases: {
      findMany: jest.fn(
        ({ where }: { where: { system?: string; is_active?: boolean } }) =>
          Promise.resolve(
            rows.filter(
              (r) =>
                (!where.system || r.system === where.system) &&
                (where.is_active === undefined ||
                  r.is_active === where.is_active),
            ),
          ),
      ),
      findFirst: jest.fn(
        ({ where }: { where: { system: string; code: { equals: string } } }) =>
          Promise.resolve(
            rows.find(
              (r) =>
                r.system === where.system &&
                r.code.toLowerCase() === where.code.equals.toLowerCase(),
            ) ?? null,
          ),
      ),
      create: jest.fn(({ data }: { data: Omit<Row, 'id' | 'is_active'> }) => {
        const row = { id: `a-${++seq}`, is_active: true, ...data };
        rows.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
    },
    profiles: {
      findFirst: jest.fn(
        ({ where }: { where: { email: { equals: string } } }) =>
          Promise.resolve(
            where.email.equals === 'uriel@abent3t.com'
              ? { id: 'p-uriel' }
              : null,
          ),
      ),
    },
  };
  const service = new ErpAliasesService(prisma as unknown as PrismaService);
  return { service, prisma, rows };
}

describe('ErpAliasesService', () => {
  it('resolveMany traduce solo los códigos con alias, sin distinguir mayúsculas', async () => {
    const { service } = makeHarness([
      {
        id: '1',
        system: 'maximo',
        code: 'CGAZB',
        display_name: 'Carlos Gaz',
        profile_id: null,
        is_active: true,
      },
      {
        id: '2',
        system: 'maximo',
        code: 'OLD',
        display_name: 'Inactivo',
        profile_id: null,
        is_active: false,
      },
    ]);
    const names = await service.resolveMany('maximo', [
      'cgazb',
      'AMMD1',
      null,
      'OLD',
    ]);
    expect([...names.entries()]).toEqual([['cgazb', 'Carlos Gaz']]);
    expect(await service.displayName('maximo', 'AMMD1')).toBe('AMMD1');
    expect(await service.displayName('sap', 'CGAZB')).toBe('CGAZB');
  });

  it('importa CSV con encabezados en español, sistema por defecto y perfil por email', async () => {
    const { service, rows } = makeHarness([
      {
        id: '1',
        system: 'maximo',
        code: 'CGAZB',
        display_name: 'Viejo nombre',
        profile_id: null,
        is_active: false,
      },
    ]);
    const csv = [
      'Sistema;Usuario;Nombre;Email',
      'maximo;cgazb;Carlos Gaz;',
      ';AMMD1;Ana Méndez;uriel@abent3t.com',
      'sap;Uriel LASES;Uriel Lases;nadie@abent3t.com',
      'otro;X;Y;',
      'maximo;;Sin usuario;',
    ].join('\n');
    const result = await service.importFile(
      {
        buffer: Buffer.from(csv, 'utf8'),
        originalname: 'alias.csv',
        mimetype: 'text/csv',
      },
      'maximo',
      'u-1',
    );
    expect(result).toMatchObject({
      rows: 5,
      created: 2,
      updated: 1,
      skipped: 2,
    });
    // existente (insensible a mayúsculas) → actualizado y reactivado
    const cgazb = rows.find((r) => r.code === 'CGAZB')!;
    expect(cgazb.display_name).toBe('Carlos Gaz');
    expect(cgazb.is_active).toBe(true);
    // sistema vacío → el del formulario; email conocido → perfil ligado
    const ammd1 = rows.find((r) => r.code === 'AMMD1')!;
    expect(ammd1.system).toBe('maximo');
    expect(ammd1.profile_id).toBe('p-uriel');
    // email desconocido → se carga sin ligar, con aviso
    const uriel = rows.find((r) => r.code === 'Uriel LASES')!;
    expect(uriel.system).toBe('sap');
    expect(uriel.profile_id).toBeNull();
    expect(result.errors.some((e) => e.includes('nadie@abent3t.com'))).toBe(
      true,
    );
    expect(result.errors.some((e) => e.includes('sistema inválido'))).toBe(
      true,
    );
  });

  it('rechaza archivos sin las columnas usuario/nombre', async () => {
    const { service } = makeHarness();
    await expect(
      service.importFile(
        {
          buffer: Buffer.from('a,b\n1,2', 'utf8'),
          originalname: 'x.csv',
          mimetype: 'text/csv',
        },
        'sap',
        'u-1',
      ),
    ).rejects.toThrow(/usuario/);
  });
});
