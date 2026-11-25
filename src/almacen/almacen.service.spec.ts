import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AlmacenService, sinZona } from './almacen.service';
import type { PrismaService } from '../prisma/prisma.service';

const D = (x: number | string) => new Prisma.Decimal(x);
const ID = '11111111-1111-4111-8111-111111111111';

const UBICACIONES = [
  {
    clave: 'CENTRAL',
    descripcion: 'Almacén central',
    tipo: 'STOREROOM',
    grupo: 'CENTRAL',
  },
  {
    clave: 'CONT-1',
    descripcion: 'Contenedor negro',
    tipo: 'STOREROOM',
    grupo: 'Almacenes y contenedores',
  },
  {
    clave: 'MAAB1',
    descripcion: 'Caja de herramientas',
    tipo: 'LABOR',
    grupo: 'Cajas de herramientas',
  },
];

const corte = {
  id: ID,
  almacen: 'TODOS',
  fecha_corte: new Date('2026-11-09T08:00:00Z'),
  version: 2,
  estado: 'publicado',
  titulo: 'Inventario al corte',
  fuente: 'Maximo',
  articulos: 3,
  unidades: D('39'),
  total_pesos: D('31352.9'),
  total_pesos_oc: D('31000.1'),
  sin_valuar_articulos: 2,
  sin_valuar_unidades: D('32'),
  archivo_nombre: 'Inventario.xlsx',
  archivo_sha256: 'a'.repeat(64),
  cargado_en: new Date('2026-11-24T18:00:00Z'),
  reemplazado_en: null,
  version_reporte: 2,
  revision: 'en_revision',
  aceptado_en: null,
  ubicaciones: UBICACIONES,
};

const FILAS = [
  {
    parte: '2000836',
    descripcion: 'MEZCLA',
    almacen: 'CENTRAL',
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
    almacen: 'CENTRAL',
    clasificacion: null,
    moneda: null,
    cantidad: D(2),
    unidad: 'PIEZ',
    fecha_entrada: null,
    importe_pesos: null,
    importe_pesos_oc: null,
    origen: 'Sin entrada con costo',
    motivo: 'Sin compras en Maximo',
  },
  {
    parte: '2000836',
    descripcion: 'MEZCLA',
    almacen: 'CONT-1',
    clasificacion: 'GASES \\ MEZCLA',
    moneda: 'MXN',
    cantidad: D(6),
    unidad: 'UN',
    fecha_entrada: new Date('2024-01-10T10:00:00Z'),
    importe_pesos: D('271.17'),
    importe_pesos_oc: D('271.17'),
    origen: 'Recepción',
  },
  {
    parte: '2701700',
    descripcion: 'LLAVE',
    almacen: 'MAAB1',
    clasificacion: 'HERRAMIENTAS',
    moneda: null,
    cantidad: D(30),
    unidad: 'UN',
    fecha_entrada: null,
    importe_pesos: null,
    importe_pesos_oc: null,
    origen: 'Sin entrada con costo',
    motivo: 'Sin compras en Maximo',
  },
];

const DEVOLUCIONES = [
  {
    orden: 1,
    fecha: new Date('2026-10-23T10:00:00Z'),
    fecha_captura: new Date('2026-10-23T10:00:00Z'),
    documento: '17527',
    documento_descripcion: 'Devolución',
    almacen: 'CENTRAL',
    anaquel: 'CA8B',
    parte: '2000016',
    descripcion: 'RODAMIENTO',
    cantidad: D(6),
    unidad: 'UN',
    costo_maximo_usd: D(0),
    costo: D('1860.56'),
    moneda: 'MXN',
    tipo_cambio: D(1),
    importe_pesos: D('11163.36'),
    tipo_cambio_oc: D(1),
    importe_pesos_oc: D('11163.36'),
    valuacion: 'Con la recepción más reciente del artículo',
    oc: 'PO103127/1',
    observacion: null,
    marcas: ['Costo 0 en Maximo'],
    salio_antes: D(10),
    salio_12m: D(4),
    ultima_salida: new Date('2026-09-01T09:00:00Z'),
    ot_ultima_salida: 'WO117000',
    saldo_almacen: D(6),
    saldo_otras: D(0),
  },
  {
    orden: 2,
    fecha: new Date('2026-11-07T09:00:00Z'),
    fecha_captura: null,
    documento: '17653',
    documento_descripcion: null,
    almacen: 'CONT-ROJO',
    anaquel: null,
    parte: '2004768',
    descripcion: 'VÁLVULA',
    cantidad: D(1),
    unidad: 'PIEZ',
    costo_maximo_usd: D(0),
    costo: null,
    moneda: null,
    tipo_cambio: null,
    importe_pesos: null,
    tipo_cambio_oc: null,
    importe_pesos_oc: null,
    valuacion: 'Sin costo',
    oc: null,
    observacion: 'regresó de la limpieza',
    marcas: ['Costo 0 en Maximo', 'Nunca había salido del almacén'],
    salio_antes: D(0),
    salio_12m: D(0),
    ultima_salida: null,
    ot_ultima_salida: null,
    saldo_almacen: D(1),
    saldo_otras: D(2),
  },
];

function servicio(o: { corte?: unknown } = {}) {
  const c = 'corte' in o ? o.corte : corte;
  const filtra = ({ where }: { where: { almacen?: { in: string[] } } }) =>
    Promise.resolve(
      where.almacen
        ? FILAS.filter((f) => where.almacen!.in.includes(f.almacen))
        : FILAS,
    );
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
            if (select.devoluciones_por_mes)
              return Promise.resolve({
                devoluciones_por_mes: [
                  { mes: '2026-10', lineas: 124, unidades: 1037 },
                ],
              });
            if (select.archivo)
              return Promise.resolve({
                archivo: Uint8Array.from([80, 75]),
                archivo_nombre: 'Inventario.xlsx',
              });
            return Promise.resolve(c);
          },
        ),
    },
    almacen_existencias: { findMany: jest.fn().mockImplementation(filtra) },
    almacen_devoluciones: {
      findMany: jest.fn().mockResolvedValue(DEVOLUCIONES),
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

  it('lista solo los cortes publicados, con números, su versión, su revisión y sus ubicaciones, sin el Excel', async () => {
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
      versionReporte: 2,
      revision: 'en_revision',
      aceptadoEn: null,
      totales: { pesos: 31352.9, pesosOc: 31000.1, articulos: 3, unidades: 39 },
    });
    expect(lista[0].ubicaciones.map((u) => u.clave)).toEqual([
      'CENTRAL',
      'CONT-1',
      'MAAB1',
    ]);
  });

  it('el detalle trae las notas, los totales y el resumen de todo el corte', async () => {
    const { s } = servicio();
    const d = await s.detalle(ID);
    expect(d.notas).toEqual([['Corte', '9-nov']]);
    expect(d.filtro).toBeNull();
    expect(d.totales).toEqual({
      pesos: 31352.9,
      pesosOc: 31352.9,
      articulos: 3,
      unidades: 39,
      sinValuarArticulos: 2,
      sinValuarUnidades: 32,
    });
    expect(d.resumen.ubicacion.map((g) => g.clave)).toEqual([
      'CENTRAL',
      'CONT-1',
      'MAAB1',
    ]);
    expect(d.resumen.antiguedad.map((g) => g.clave)).toEqual([
      '6 a 12 meses',
      '2 a 3 años',
      'Sin entrada con costo',
    ]);
  });

  it('filtra por la clave de una ubicación o por un grupo, y los totales son los del filtro', async () => {
    const { s, prisma } = servicio();
    const c1 = await s.detalle(ID, 'CONT-1');
    expect(c1.filtro).toBe('CONT-1');
    expect(c1.totales).toMatchObject({
      pesos: 271.17,
      articulos: 1,
      unidades: 6,
      sinValuarUnidades: 0,
    });
    const g = await s.detalle(ID, 'Cajas de herramientas');
    expect(g.almacenes).toEqual(['MAAB1']);
    expect(g.totales).toMatchObject({
      pesos: 0,
      articulos: 1,
      sinValuarArticulos: 1,
      sinValuarUnidades: 30,
    });
    const ex = await s.existencias(ID, 'CENTRAL');
    expect(ex.map((x) => x.almacen)).toEqual(['CENTRAL', 'CENTRAL']);
    expect(ex[1]).toMatchObject({
      motivo: 'Sin compras en Maximo',
      enSuInventario: undefined,
    });
    const llamadas = prisma.almacen_existencias.findMany.mock
      .calls as unknown as [{ where: unknown }][];
    expect(llamadas[llamadas.length - 1][0].where).toEqual({
      corte_id: ID,
      almacen: { in: ['CENTRAL'] },
    });
  });

  it('rechaza una ubicación que no está en el corte', async () => {
    const { s } = servicio();
    await expect(s.detalle(ID, 'CONT-9')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(s.existencias(ID, 'Otro grupo')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('en un corte de la versión 1 (sin ubicaciones) solo acepta su almacén', async () => {
    const { s } = servicio({
      corte: { ...corte, almacen: 'CENTRAL', ubicaciones: [] },
    });
    const d = await s.detalle(ID, 'CENTRAL');
    expect(d.filtro).toBe('CENTRAL');
    expect(d.totales.articulos).toBe(3);
    await expect(s.detalle(ID, 'CONT-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('las devoluciones salen con números, fechas sin zona y su resumen por día, documento, mes y marca', async () => {
    const { s } = servicio();
    const d = await s.devoluciones(ID);
    expect(d.lineas[0]).toMatchObject({
      fecha: '2026-10-23T10:00:00',
      cantidad: 6,
      costoMaximoUsd: 0,
      importePesos: 11163.36,
      salioAntes: 10,
      ultimaSalida: '2026-09-01T09:00:00',
    });
    expect(d.lineas[1]).toMatchObject({
      importePesos: null,
      observacion: 'regresó de la limpieza',
      saldoOtras: 2,
    });
    expect(d.resumen.totales).toMatchObject({
      lineas: 2,
      unidades: 7,
      articulos: 2,
      documentos: 2,
      centralLineas: 1,
      centralUnidades: 6,
      costoCero: 2,
      sinValuar: 1,
      pesos: 11163.36,
    });
    expect(d.resumen.porMes).toEqual([
      { mes: '2026-10', lineas: 124, unidades: 1037 },
    ]);
    expect(d.resumen.porMarca.map((m) => m.marca)).toEqual([
      'Costo 0 en Maximo',
      'Nunca había salido del almacén',
    ]);
  });

  it('responde 404 si el corte no existe', async () => {
    const { s } = servicio({ corte: null });
    await expect(s.detalle(ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.existencias(ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.devoluciones(ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.excel(ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el Excel sale tal cual se cargó', async () => {
    const { s } = servicio();
    const x = await s.excel(ID);
    expect(x.nombre).toBe('Inventario.xlsx');
    expect([...x.archivo]).toEqual([80, 75]);
  });
});
