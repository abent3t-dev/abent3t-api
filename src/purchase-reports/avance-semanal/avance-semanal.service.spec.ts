import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import type { PrismaService } from '../../prisma/prisma.service';
import { PurchaseReportsController } from '../purchase-reports.controller';
import { buildAvancePage, type AvanceData } from './avance-semanal.engine';
import { renderAvancePdf } from './avance-semanal.pdf';
import { AVANCE_REGLAS } from './avance-semanal.reglas';
import { AvanceSemanalService } from './avance-semanal.service';

/**
 * H1 — semanas pedidas, nombre del archivo y prueba de humo del PDF (no
 * vacío, una página por semana). K5 (2026-10-05): la página de Maximo con
 * canceladas y la conciliación contra Jorge (solo super_admin).
 */

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const NOW = new Date('2026-09-30T18:00:00Z');

function makeService() {
  // Sin datos: cada consulta regresa vacío
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
  return new AvanceSemanalService(prisma as unknown as PrismaService);
}

const pageCount = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;

describe('AvanceSemanalService.resolveWeeks', () => {
  const service = makeService();
  const iso = (weeks: Date[]) => weeks.map((d) => d.toISOString().slice(0, 10));

  it('sin parámetros: la última semana completa', () => {
    expect(iso(service.resolveWeeks({}, NOW))).toEqual(['2026-09-21']);
  });

  it('una semana: cualquier día da su lunes; nunca después de la semana en curso', () => {
    expect(iso(service.resolveWeeks({ semana: '2026-09-24' }, NOW))).toEqual([
      '2026-09-21',
    ]);
    expect(iso(service.resolveWeeks({ semana: '2026-12-01' }, NOW))).toEqual([
      '2026-09-28',
    ]);
  });

  it('acumulado: del más nuevo al más viejo; `desde` sin `hasta` = hasta la última completa', () => {
    expect(
      iso(
        service.resolveWeeks({ desde: '2026-09-07', hasta: '2026-09-21' }, NOW),
      ),
    ).toEqual(['2026-09-21', '2026-09-14', '2026-09-07']);
    expect(iso(service.resolveWeeks({ desde: '2026-09-14' }, NOW))).toEqual([
      '2026-09-21',
      '2026-09-14',
    ]);
  });

  it('rango al revés, fecha inválida o más de 60 semanas → 400', () => {
    expect(() =>
      service.resolveWeeks({ desde: '2026-09-21', hasta: '2026-09-01' }, NOW),
    ).toThrow(BadRequestException);
    expect(() => service.resolveWeeks({ semana: '2026-13-45' }, NOW)).toThrow(
      BadRequestException,
    );
    expect(() =>
      service.resolveWeeks({ desde: '2025-01-06', hasta: '2026-09-21' }, NOW),
    ).toThrow(BadRequestException);
  });
});

describe('PDF del reporte de avance semanal', () => {
  it('I3: una semana = dos páginas (Maximo y luego SAP) y el nombre con su lunes', async () => {
    const service = makeService();
    const pages = await service.getPaginas({ semana: '2026-09-21' });
    expect(pages.map((p) => [p.fuente.clave, p.semana.lunes])).toEqual([
      ['maximo', '2026-09-21'],
      ['sap', '2026-09-21'],
    ]);
    const { buffer, filename } = await service.buildPdf({
      semana: '2026-09-21',
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(buffer)).toBe(2);
    expect(filename).toBe('reporte_avance_semanal_2026-09-21.pdf');
    // el índice: marcadores por sistema
    const raw = buffer.toString('latin1');
    expect(raw).toContain('/Outlines');
    expect(raw).toContain('(Maximo)');
    expect(raw).toContain('(SAP)');
  });

  it('I3: el acumulado va por sección — todas las semanas de Maximo y luego las de SAP', async () => {
    const pages = await makeService().getPaginas({
      desde: '2026-09-07',
      hasta: '2026-09-21',
    });
    expect(pages.map((p) => `${p.fuente.clave} ${p.semana.lunes}`)).toEqual([
      'maximo 2026-09-21',
      'maximo 2026-09-14',
      'maximo 2026-09-07',
      'sap 2026-09-21',
      'sap 2026-09-14',
      'sap 2026-09-07',
    ]);
  });

  it('I3: el JSON por defecto trae las dos páginas, cada una con sus definiciones', async () => {
    const both = (await makeService().getSemana({ semana: '2026-09-21' })) as {
      paginas: Array<{
        fuente: { clave: string };
        definiciones: Record<string, string>;
      }>;
    };
    expect(both.paginas.map((p) => p.fuente.clave)).toEqual(['maximo', 'sap']);
    expect(both.paginas[1].definiciones.gestion).toBe(
      'Gestión = solicitud de pedido de SAP.',
    );
    const one = (await makeService().getSemana({
      semana: '2026-09-21',
      fuente: 'todas',
    })) as { fuente: { clave: string } };
    expect(one.fuente.clave).toBe('todas');
  });

  it('acumulado: una página por semana; la fuente va en el nombre', async () => {
    const { buffer, filename } = await makeService().buildPdf({
      desde: '2026-08-31',
      hasta: '2026-09-21',
      fuente: 'maximo',
    });
    expect(pageCount(buffer)).toBe(4);
    expect(filename).toBe(
      'reporte_avance_semanal_2026-08-31_al_2026-09-21_maximo.pdf',
    );
  });

  it('con datos: renderiza todas las secciones sin romperse (monedas, medidores, enero)', async () => {
    const data: AvanceData = {
      gestiones: [
        {
          sistema: 'sap',
          folio: '1',
          recibida: D('2026-01-12'),
          fecha_origen: 'documento',
          inicio_dias: D('2026-01-12'),
          primera_oc: D('2026-01-20'),
          cierre_sin_oc: null,
          cancelada: null,
          de_contrato: false,
        },
        {
          sistema: 'maximo',
          folio: 'PR1',
          recibida: D('2025-12-15'),
          fecha_origen: 'aprobacion',
          inicio_dias: D('2025-12-15'),
          primera_oc: null,
          cierre_sin_oc: null,
          cancelada: null,
          de_contrato: false,
        },
        {
          sistema: 'maximo',
          folio: 'PR2',
          recibida: D('2026-01-13'),
          fecha_origen: 'aprobacion',
          inicio_dias: D('2026-01-13'),
          primera_oc: null,
          cierre_sin_oc: null,
          cancelada: D('2026-01-22'),
          de_contrato: false,
        },
      ],
      ordenes: [
        {
          sistema: 'sap',
          fecha: D('2026-01-20'),
          moneda: 'MXN',
          monto: 1234567.89,
          subtotal: 1064282.66,
          contada_en_maximo: false,
        },
        {
          sistema: 'sap',
          fecha: D('2026-01-21'),
          moneda: 'EUR',
          monto: 500,
          subtotal: null,
          contada_en_maximo: false,
        },
      ],
      maximo_no_recibidas: [
        { prnum: 'PR3', emision: D('2026-01-14'), pr_status: 'WAPPR' },
        { prnum: 'PR4', emision: null, pr_status: null },
      ],
      sap_desde: D('2026-01-12'),
    };
    const pages = ['2026-01-19', '2026-01-26'].flatMap((lunes) =>
      (['todas', 'maximo'] as const).map((fuente) =>
        buildAvancePage(data, D(lunes), fuente, NOW),
      ),
    );
    expect(pages[1].cancelacion.semanas.map((s) => s.canceladas)).toEqual([
      0, 0, 0, 1,
    ]);
    const pdf = await renderAvancePdf(pages);
    expect(pageCount(pdf)).toBe(4);
    expect(pdf.length).toBeGreaterThan(10_000);
  });
});

describe('K5.7: conciliación contra la serie de Jorge', () => {
  it('pide super_admin y no entra a las lecturas abiertas', () => {
    const proto = PurchaseReportsController.prototype as unknown as Record<
      string,
      object
    >;
    const handler = proto.getAvanceConciliacion;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'avance-semanal/conciliacion',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0); // GET
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['super_admin']);
  });

  it('sin datos: 38 semanas, el criterio no se cumple y los parámetros cambian solo su regla', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const service = new AvanceSemanalService(
      prisma as unknown as PrismaService,
    );
    const conc = await service.getConciliacion({
      recibida: 'emision',
      corte: 'viernes',
    });
    expect(conc.semanas).toHaveLength(38);
    expect(conc.semanas[0]).toMatchObject({ pagina: 1, lunes: '2026-09-21' });
    expect(conc.semanas[37]).toMatchObject({
      pagina: 38,
      lunes: '2026-01-05',
    });
    expect(conc.criterio.cumple).toBe(false);
    expect(conc.opciones.reglas).toEqual({
      ...AVANCE_REGLAS,
      recibida: 'emision',
      corte: 'viernes',
    });
    expect(conc.montos.map((m) => m.anio)).toEqual([2026, 2025]);
    expect(conc.anual.map((a) => a.anio)).toEqual([
      2022, 2023, 2024, 2025, 2026,
    ]);
    expect(conc.duracion_ms).toBeGreaterThanOrEqual(0);
    // una sola carga de datos (6 consultas)
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(6);
  });
});
