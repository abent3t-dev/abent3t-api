import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AlmacenService, sinZona } from './almacen.service';
import type { PrismaService } from '../prisma/prisma.service';

const D = (x: number | string) => new Prisma.Decimal(x);
const ID = '11111111-1111-4111-8111-111111111111';

const corte = {
  id: ID,
  almacen: 'CENTRAL',
  fecha_corte: new Date('2026-11-09T08:00:00Z'),
  version: 1,
  estado: 'publicado',
  titulo: 'Inventario al corte',
  fuente: 'Maximo',
  articulos: 2,
  unidades: D('6'),
  total_pesos: D('31352.9'),
  total_pesos_oc: D('31000.1'),
  sin_valuar_articulos: 1,
  sin_valuar_unidades: D('2'),
  archivo_nombre: 'Inventario.xlsx',
  archivo_sha256: 'a'.repeat(64),
  cargado_en: new Date('2026-11-24T18:00:00Z'),
  reemplazado_en: null,
};

function servicio(
  o: { corte?: unknown; filas?: unknown[]; archivo?: unknown } = {},
) {
  const c = 'corte' in o ? o.corte : corte;
  const prisma = {
    almacen_cortes: {
      findMany: jest.fn().mockResolvedValue(c ? [c] : []),
      findUnique: jest
        .fn()
        .mockImplementation(
          ({ select }: { select: Record<string, boolean> }) => {
            if (!c) return Promise.resolve(null);
            if (select.notas)
              return Promise.resolve({ notas: [['Corte', '9-nov']] });
            if (select.archivo)
              return Promise.resolve(
                o.archivo ?? {
                  archivo: Uint8Array.from([80, 75]),
                  archivo_nombre: 'Inventario.xlsx',
                },
              );
            return Promise.resolve(c);
          },
        ),
    },
    almacen_existencias: {
      findMany: jest.fn().mockResolvedValue(
        o.filas ?? [
          {
            parte: '2000836',
            descripcion: 'MEZCLA',
            clasificacion: 'GASES \\ MEZCLA',
            moneda: 'MXN',
            cantidad: D(1),
            unidad: 'UN',
            fecha_entrada: new Date('2025-11-12T16:02:11Z'),
            importe_pesos: D('31081.73'),
            importe_pesos_oc: D('31081.73'),
            origen: 'Recepción',
          },
          {
            parte: '2004768',
            descripcion: 'VÁLVULA',
            clasificacion: null,
            moneda: null,
            cantidad: D(2),
            unidad: 'PIEZ',
            fecha_entrada: null,
            importe_pesos: null,
            importe_pesos_oc: null,
            origen: 'Sin entrada con costo',
          },
        ],
      ),
    },
  };
  return { s: new AlmacenService(prisma as unknown as PrismaService), prisma };
}

describe('Almacén — service', () => {
  it('las fechas sin zona salen tal cual, sin cambio de hora', () => {
    expect(sinZona(new Date('2026-11-09T08:00:00Z'))).toBe(
      '2026-11-09T08:00:00',
    );
    expect(sinZona(null)).toBeNull();
  });

  it('lista solo los cortes publicados, con números y sin el Excel', async () => {
    const { s, prisma } = servicio();
    const lista = await s.cortes();
    const llamadas = prisma.almacen_cortes.findMany.mock.calls as unknown as [
      { where: unknown; select: Record<string, unknown> },
    ][];
    const arg = llamadas[0][0];
    expect(arg.where).toEqual({ estado: 'publicado' });
    expect(arg.select.archivo).toBeUndefined();
    expect(lista[0]).toMatchObject({
      fechaCorte: '2026-11-09T08:00:00',
      totales: { pesos: 31352.9, pesosOc: 31000.1, articulos: 2, unidades: 6 },
    });
  });

  it('el detalle trae las notas y el resumen de las gráficas', async () => {
    const { s } = servicio();
    const d = await s.detalle(ID);
    expect(d.notas).toEqual([['Corte', '9-nov']]);
    expect(d.resumen.clasificacion.map((g) => g.clave)).toEqual([
      'GASES',
      'Sin clasificación',
    ]);
    expect(d.resumen.antiguedad.map((g) => g.clave)).toEqual([
      '6 a 12 meses',
      'Sin entrada con costo',
    ]);
  });

  it('responde 404 si el corte no existe', async () => {
    const { s } = servicio({ corte: null });
    await expect(s.detalle(ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.existencias(ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.excel(ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el Excel sale tal cual se cargó', async () => {
    const { s } = servicio();
    const x = await s.excel(ID);
    expect(x.nombre).toBe('Inventario.xlsx');
    expect([...x.archivo]).toEqual([80, 75]);
  });
});
