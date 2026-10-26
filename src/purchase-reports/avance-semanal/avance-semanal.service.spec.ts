import 'reflect-metadata';
import PDFDocument from 'pdfkit';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import type { PrismaService } from '../../prisma/prisma.service';
import { AvanceConciliacionDto } from '../dto/avance-semanal.dto';
import { PurchaseReportsController } from '../purchase-reports.controller';
import { opcionesConciliacion } from './avance-semanal.conciliacion';
import { buildAvancePage, type AvanceData } from './avance-semanal.engine';
import { renderAvancePdf } from './avance-semanal.pdf';
import {
  AVANCE_MONTO_BASE,
  AVANCE_MONTOS_FUENTE_MAXIMO,
  AVANCE_OPCIONES,
  AVANCE_REGLAS,
  avanceReglasVigentes,
  montoBaseTexto,
} from './avance-semanal.reglas';
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

describe('PDF: tarjeta de montos (H9, H18)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('H18: el pie con tres monedas y OC sin subtotal entra completo (sin "…"); H9: el mes sin subtotal dice "No disponible"', async () => {
    const oc = (
      fecha: string,
      moneda: string,
      monto: number,
      subtotal: number | null,
    ): AvanceData['ordenes'][number] => ({
      sistema: 'maximo',
      fecha: new Date(`${fecha}T15:00:00Z`),
      moneda,
      monto,
      subtotal,
      contada_en_maximo: false,
    });
    const data: AvanceData = {
      gestiones: [],
      ordenes: [
        oc('2026-03-10', 'MXN', 1_160_000, 1_000_000),
        oc('2026-04-10', 'USD', 116_000.55, 100_000.47),
        oc('2026-05-10', 'EUR', 2_035.8, 1_755),
        // junio: solo OC sin subtotal (cinco)
        ...[11, 12, 13, 14, 15].map((d) =>
          oc(`2026-06-${d}`, 'MXN', 58_000, null),
        ),
      ],
      maximo_no_recibidas: [],
      sap_desde: null,
    };
    // la presentación sin IVA (H9/H18); O1: el default ya es con IVA y, sin
    // tipos de cambio, el dólar y el euro se quedan en su moneda
    const page = buildAvancePage(data, D('2026-09-21'), 'maximo', NOW, {
      ...AVANCE_OPCIONES,
      monto_base: 'sin_iva',
    });
    expect(page.montos.monedas).toEqual(['MXN', 'USD', 'EUR']);
    expect(page.montos.sin_subtotal.ordenes).toBe(5);

    // Cada texto del PDF con el alto que se le dio y el que necesita
    const proto = PDFDocument.prototype as unknown as {
      text: (...args: unknown[]) => unknown;
    };
    const original = proto.text;
    const textos: Array<{ texto: string; alto?: number; necesita: number }> =
      [];
    jest.spyOn(proto, 'text').mockImplementation(function (
      this: PDFKit.PDFDocument,
      ...args: unknown[]
    ) {
      const [s, , , opts] = args as [
        unknown,
        number,
        number,
        { width?: number; height?: number } | undefined,
      ];
      if (typeof s === 'string') {
        textos.push({
          texto: s,
          alto: opts?.height,
          necesita: opts?.width
            ? this.heightOfString(s, { width: opts.width, lineGap: 0 })
            : 0,
        });
      }
      return original.apply(this, args);
    });
    const pdf = await renderAvancePdf([page]);
    expect(pageCount(pdf)).toBe(1);

    const pie = textos.find((t) =>
      t.texto.includes('OC sin subtotal (no se estiman)'),
    );
    expect(pie).toBeDefined();
    // el otro valor de las tres monedas, la moneda extra y las OC sin subtotal
    expect(pie!.texto).toContain('Además: EUR 1,755.00 (sin convertir)');
    expect(pie!.texto).toMatch(/Con IVA: MXN .* · USD .* · EUR 2,035\.80/);
    expect(pie!.texto).toContain('5 OC sin subtotal (no se estiman)');
    // antes: 18 pt (un renglón) y el resto se cortaba con "…"
    expect(pie!.necesita).toBeGreaterThan(18);
    expect(pie!.alto).toBeGreaterThanOrEqual(pie!.necesita);
    // H9: junio trae compras sin subtotal (≠ "—" de un mes sin OC)
    expect(textos.filter((t) => t.texto === 'No disponible')).toHaveLength(1);
  });
});

describe('PDF: días hábiles (H3)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('las tarjetas de días dicen "días hábiles"; el rótulo en dos renglones no se encima con la mediana', async () => {
    const dia = (n: number) =>
      new Date(`2026-08-${String(n).padStart(2, '0')}T15:00:00Z`);
    const DIA_MS = 86_400_000;
    const gestiones: AvanceData['gestiones'] = Array.from(
      { length: 10 },
      (_, i) => ({
        sistema: 'maximo' as const,
        folio: `PR${i}`,
        recibida: dia(3 + i),
        fecha_origen: 'aprobacion' as const,
        inicio_dias: dia(3 + i),
        // ~20 naturales = ~14 hábiles (dos cifras: el rótulo no cabe en uno)
        primera_oc: i % 2 ? new Date(dia(3 + i).getTime() + 20 * DIA_MS) : null,
        cierre_sin_oc: null,
        cancelada: i % 2 ? null : new Date(dia(3 + i).getTime() + 22 * DIA_MS),
        de_contrato: false,
      }),
    );
    const data: AvanceData = {
      gestiones,
      ordenes: [],
      maximo_no_recibidas: [],
      sap_desde: null,
      festivos: ['2026-09-16'],
    };
    const page = buildAvancePage(data, D('2026-09-21'), 'maximo', NOW, {
      ...AVANCE_OPCIONES,
      reglas: { ...AVANCE_REGLAS, dias_tipo: 'habiles' },
    });
    expect(page.cierre.anio.promedio_dias).toBeGreaterThanOrEqual(10);
    expect(page.cancelacion.anio?.promedio_dias).toBeGreaterThanOrEqual(10);

    const proto = PDFDocument.prototype as unknown as {
      text: (...args: unknown[]) => unknown;
    };
    const original = proto.text;
    const textos: Array<{ texto: string; y: number; necesita: number }> = [];
    jest.spyOn(proto, 'text').mockImplementation(function (
      this: PDFKit.PDFDocument,
      ...args: unknown[]
    ) {
      const [s, , y, opts] = args as [
        unknown,
        number,
        number,
        { width?: number } | undefined,
      ];
      if (typeof s === 'string') {
        textos.push({
          texto: s,
          y,
          necesita: opts?.width
            ? this.heightOfString(s, { width: opts.width, lineGap: 0 })
            : 0,
        });
      }
      return original.apply(this, args);
    });
    await renderAvancePdf([page]);

    const rotulos = textos.filter((t) => t.texto === 'días hábiles promedio');
    const medianas = textos.filter((t) =>
      /^Mediana .* días hábiles · sobre/.test(t.texto),
    );
    // cierre y cancelación
    expect(rotulos).toHaveLength(2);
    expect(medianas).toHaveLength(2);
    expect(textos.some((t) => t.texto === 'días promedio')).toBe(false);
    rotulos.forEach((rotulo, i) => {
      // con dos cifras va en dos renglones y termina antes de la mediana
      expect(rotulo.necesita).toBeGreaterThan(14);
      expect(rotulo.y + rotulo.necesita).toBeLessThanOrEqual(medianas[i].y);
    });
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

  it('H3: el DTO acepta dias_tipo=habiles (no lo descarta el whitelist) y rechaza otro valor', async () => {
    // espejo de main.ts
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const meta = {
      type: 'query' as const,
      metatype: AvanceConciliacionDto,
      data: '',
    };
    const ok = (await pipe.transform(
      { dias_tipo: 'habiles', corte: 'viernes' },
      meta,
    )) as AvanceConciliacionDto;
    expect(ok).toEqual({ dias_tipo: 'habiles', corte: 'viernes' });
    expect(opcionesConciliacion(ok).reglas.dias_tipo).toBe('habiles');
    const naturales = (await pipe.transform(
      { dias_tipo: 'naturales' },
      meta,
    )) as AvanceConciliacionDto;
    expect(naturales.dias_tipo).toBe('naturales');
    // sin el parámetro: default (O1: hábiles)
    const vacio = (await pipe.transform({}, meta)) as AvanceConciliacionDto;
    expect(opcionesConciliacion(vacio).reglas.dias_tipo).toBe('habiles');
    // O1: tipo de cambio y promedio del título pasan el whitelist
    const o1 = (await pipe.transform(
      { tipo_cambio: 'sap', promedio_titulo: 'semana' },
      meta,
    )) as AvanceConciliacionDto;
    expect(opcionesConciliacion(o1)).toMatchObject({
      tipo_cambio: 'sap',
      promedio_titulo: 'semana',
    });
    await expect(
      pipe.transform({ tipo_cambio: 'banxico' }, meta),
    ).rejects.toThrow(BadRequestException);
    for (const malo of ['laborales', 'HABILES', '']) {
      await expect(pipe.transform({ dias_tipo: malo }, meta)).rejects.toThrow(
        BadRequestException,
      );
    }
  });

  it('sin datos: 38 semanas, el criterio no se cumple y los parámetros cambian solo su regla', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const service = new AvanceSemanalService(
      prisma as unknown as PrismaService,
    );
    const conc = await service.getConciliacion({
      recibida: 'emision',
      corte: 'viernes',
      dias_tipo: 'habiles',
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
      dias_tipo: 'habiles',
    });
    // H2 y H3: el bloque de hipótesis
    expect(conc.hipotesis.h2.semanas).toBeGreaterThan(0);
    expect(conc.hipotesis.h3).toContain('cuenta días hábiles');
    expect(conc.montos.map((m) => m.anio)).toEqual([2026, 2025]);
    expect(conc.anual.map((a) => a.anio)).toEqual([
      2022, 2023, 2024, 2025, 2026,
    ]);
    expect(conc.duracion_ms).toBeGreaterThanOrEqual(0);
    // una sola carga de datos (9 consultas: H3 los festivos y O1 los tipos
    // de cambio)
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(9);
    // O1.5: el informe de RQ de octubre, aun sin datos
    expect(conc.rq_octubre.puntos.map((p) => p.dia)).toEqual([
      '2026-10-16',
      '2026-10-20',
    ]);
  });
});

describe('H4: reglas vigentes del avance (tarjeta de Reportes)', () => {
  it('GET avance-semanal/reglas: lectura abierta y con la base de las constantes, sin tocar la BD', () => {
    const proto = PurchaseReportsController.prototype as unknown as Record<
      string,
      object
    >;
    const handler = proto.getAvanceReglas;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'avance-semanal/reglas',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0); // GET
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();

    const prisma = { $queryRaw: jest.fn() };
    const controller = new PurchaseReportsController(
      {} as never,
      {} as never,
      {} as never,
      new AvanceSemanalService(prisma as unknown as PrismaService),
    );
    const reglas = controller.getAvanceReglas();
    expect(reglas).toMatchObject({
      monto_base: AVANCE_MONTO_BASE,
      monto_base_texto: montoBaseTexto(AVANCE_MONTO_BASE),
      montos_fuente_maximo: AVANCE_MONTOS_FUENTE_MAXIMO,
      reglas: AVANCE_REGLAS,
    });
    // H3: las reglas vigentes dicen cómo se cuentan los días
    expect(reglas.reglas.dias_tipo).toBe(AVANCE_REGLAS.dias_tipo);
    expect(reglas.monto_base_nota).toMatch(
      new RegExp(`^Montos ${montoBaseTexto(AVANCE_MONTO_BASE)}`),
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('si la constante pasa a \'con_iva\', la respuesta lo dice (la tarjeta ya no dice "sin IVA" fijo)', () => {
    const conIva = avanceReglasVigentes({
      ...AVANCE_OPCIONES,
      monto_base: 'con_iva',
    });
    expect(conIva).toMatchObject({
      monto_base: 'con_iva',
      monto_base_texto: 'con IVA',
      otra_base: 'sin_iva',
      otra_base_texto: 'sin IVA',
    });
    expect(conIva.monto_base_nota).toMatch(/^Montos con IVA; el valor sin IVA/);
    const sinIva = avanceReglasVigentes({
      ...AVANCE_OPCIONES,
      monto_base: 'sin_iva',
    });
    // el texto que la tarjeta tenía escrito a mano, y (O1) lo de Maximo
    expect(sinIva.monto_base_nota).toBe(
      'Montos sin IVA (suma de las líneas de la OC; las OC sin subtotal no se suman ni se estiman); el valor con IVA va en una línea chica. En Maximo, sin las OC de contrato y con dólares y euros en pesos (el tipo de cambio de Maximo del día), como el reporte de Compras; solo en este reporte.',
    );
    expect(sinIva.tipo_cambio).toBe('maximo');
    expect(sinIva.promedio_titulo).toBe('anio');
  });
});
