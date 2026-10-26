import 'reflect-metadata';
import { createHash } from 'crypto';
import PDFDocument from 'pdfkit';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { AvanceSemanalDto } from '../dto/avance-semanal.dto';
import {
  type AvanceData,
  avanceDefiniciones,
  type AvancePage,
  buildAvancePage,
  type Gestion,
  type GrupoClave,
  type GruposConteo,
} from './avance-semanal.engine';
import { renderAvancePdf } from './avance-semanal.pdf';
import {
  AVANCE_GRUPOS_MAXIMO,
  AVANCE_OPCIONES,
  AVANCE_REGLAS,
} from './avance-semanal.reglas';
import { AvanceSemanalService } from './avance-semanal.service';

/**
 * L2 (2026-10-08) — vista previa de los grupos de la página de Maximo
 * (`?grupos=contrato`): "Cerradas sin contrato", "De contrato (OC
 * automática)", "Canceladas en Maximo" y "Abiertas" en la dona, los
 * medidores, las barras, la banda, la nota del pie y el Excel (si la página
 * trae los grupos). La tarjeta de avance no cambia. Sin el parámetro, la
 * página sale EXACTAMENTE igual que antes del cambio: las huellas de abajo se
 * calcularon con el código de K5.7 (api `98c27e0`), antes de L2. Si algún día
 * se aprueba 'contrato' como default, estas huellas pasan a fijar
 * `grupos='estandar'` (se pide explícito).
 *
 * O1 (2026-10-26) cambió el default a propósito (corte el viernes, días
 * hábiles, montos con IVA sin las OC de contrato, la leyenda de las recibidas
 * y el promedio del título): las huellas se recalcularon con el código de
 * O1. Lo que fijan sigue igual: sin el parámetro, la página no trae grupos.
 */

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const T = (iso: string) => new Date(iso);
const NOW = T('2026-09-30T18:00:00Z');
const LUNES = D('2026-09-21');

const pr = (folio: string, o: Partial<Gestion>): Gestion => {
  const recibida = o.recibida ?? T('2026-09-01T15:00:00Z');
  return {
    sistema: 'maximo',
    folio,
    recibida,
    fecha_origen: 'aprobacion',
    inicio_dias: recibida,
    primera_oc: null,
    cierre_sin_oc: null,
    cancelada: null,
    de_contrato: false,
    ...o,
  };
};

const solicitud = (folio: string, o: Partial<Gestion>): Gestion =>
  pr(folio, { sistema: 'sap', fecha_origen: 'documento', ...o });

/**
 * Semana del 21-sep-2026 (corte: domingo 27, 23:59 de México). Recibidas de
 * Maximo en 2026: 9 = 3 cerradas sin contrato (A, B, I) + 2 de contrato
 * cerradas (C con OC, D por CLOSE) + 2 canceladas en Maximo (E de contrato,
 * F) + 2 abiertas (G; H de contrato con su OC después del corte).
 */
const GESTIONES: Gestion[] = [
  pr('PR-A', {
    recibida: T('2026-09-01T15:00:00Z'),
    primera_oc: T('2026-09-08T15:00:00Z'),
  }),
  pr('PR-B', {
    recibida: T('2026-09-02T15:00:00Z'),
    cierre_sin_oc: T('2026-09-10T15:00:00Z'),
  }),
  pr('PR-C', {
    recibida: T('2026-09-03T15:00:00Z'),
    primera_oc: T('2026-09-04T15:00:00Z'),
    de_contrato: true,
  }),
  pr('PR-D', {
    recibida: T('2026-09-05T15:00:00Z'),
    cierre_sin_oc: T('2026-09-06T15:00:00Z'),
    de_contrato: true,
  }),
  pr('PR-E', {
    recibida: T('2026-09-07T15:00:00Z'),
    cancelada: T('2026-09-09T15:00:00Z'),
    de_contrato: true,
  }),
  pr('PR-F', {
    recibida: T('2026-08-20T15:00:00Z'),
    cancelada: T('2026-09-23T15:00:00Z'),
  }),
  pr('PR-G', { recibida: T('2026-09-22T15:00:00Z') }),
  pr('PR-H', {
    recibida: T('2026-09-24T15:00:00Z'),
    primera_oc: T('2026-10-01T15:00:00Z'),
    de_contrato: true,
  }),
  pr('PR-I', {
    recibida: T('2026-09-23T15:00:00Z'),
    primera_oc: T('2026-09-25T15:00:00Z'),
  }),
  // 2025: 1 de contrato, 1 cerrada, 1 cancelada y 1 abierta
  pr('PR-J', {
    recibida: T('2025-06-10T15:00:00Z'),
    primera_oc: T('2025-06-11T15:00:00Z'),
    de_contrato: true,
  }),
  pr('PR-K', {
    recibida: T('2025-07-01T15:00:00Z'),
    primera_oc: T('2025-07-20T15:00:00Z'),
  }),
  pr('PR-L', {
    recibida: T('2025-08-01T15:00:00Z'),
    cancelada: T('2025-08-15T15:00:00Z'),
  }),
  pr('PR-M', { recibida: T('2025-11-01T15:00:00Z') }),
  // 2024: de contrato cerrada por CLOSE
  pr('PR-N', {
    recibida: T('2024-03-01T15:00:00Z'),
    cierre_sin_oc: T('2024-03-02T15:00:00Z'),
    de_contrato: true,
  }),
  // SAP
  solicitud('1', { recibida: D('2026-09-01'), primera_oc: D('2026-09-05') }),
  solicitud('2', { recibida: D('2026-09-02'), cancelada: D('2026-09-09') }),
  solicitud('3', { recibida: D('2026-09-22') }),
];

const DATA: AvanceData = {
  gestiones: GESTIONES,
  ordenes: [
    {
      sistema: 'maximo',
      fecha: T('2026-03-10T15:00:00Z'),
      moneda: 'MXN',
      monto: 116_000,
      subtotal: 100_000,
      contada_en_maximo: false,
    },
    {
      sistema: 'maximo',
      fecha: T('2026-05-10T15:00:00Z'),
      moneda: 'USD',
      monto: 11_600,
      subtotal: null,
      contada_en_maximo: false,
    },
    {
      sistema: 'sap',
      fecha: D('2026-09-05'),
      moneda: 'MXN',
      monto: 58_000,
      subtotal: 50_000,
      contada_en_maximo: false,
    },
  ],
  maximo_no_recibidas: [
    { prnum: 'PR-W', emision: T('2026-09-15T15:00:00Z'), pr_status: 'WAPPR' },
  ],
  sap_desde: D('2026-01-12'),
};

/** Huella corta (sha256) de un valor serializado. */
const huella = (valor: unknown) =>
  createHash('sha256').update(JSON.stringify(valor)).digest('hex').slice(0, 16);

const r2 = (n: unknown) =>
  typeof n === 'number' ? Math.round(n * 100) / 100 : null;

type TextoPdf = [
  string,
  number | null,
  number | null,
  number | null,
  number | null,
  string | null,
];

interface TextoMedido {
  texto: string;
  x: number;
  y: number;
  /** Alto que se le dio (con "…" si no cabe); undefined = sin tope. */
  alto?: number;
  /** Alto que ocupa dibujado, con su ancho y su `lineGap`. */
  dibujado: number;
  /**
   * Alto que pdfkit pide para no cortar con "…": con `lineGap` negativo, el
   * penúltimo renglón exige espacio para dos renglones completos.
   */
  necesita: number;
  /** Ancho del texto en un renglón. */
  largo: number;
}

interface OpcionesTexto {
  width?: number;
  height?: number;
  align?: string;
  lineGap?: number;
}

/**
 * Espía `text` de pdfkit mientras se dibujan las páginas. `registrar` recibe
 * el documento (con la letra ya puesta), el texto y sus argumentos.
 */
async function espiarTextos(
  pages: AvancePage[],
  registrar: (
    doc: PDFKit.PDFDocument,
    s: string,
    x: number,
    y: number,
    opts: OpcionesTexto | undefined,
  ) => void,
): Promise<void> {
  const proto = PDFDocument.prototype as unknown as {
    text: (...args: unknown[]) => unknown;
  };
  const original = proto.text;
  const spy = jest.spyOn(proto, 'text').mockImplementation(function (
    this: PDFKit.PDFDocument,
    ...args: unknown[]
  ) {
    const [s, x, y, opts] = args as [
      unknown,
      number,
      number,
      OpcionesTexto | undefined,
    ];
    if (typeof s === 'string') registrar(this, s, x, y, opts);
    return original.apply(this, args);
  });
  try {
    await renderAvancePdf(pages);
  } finally {
    spy.mockRestore();
  }
}

/**
 * Cada texto que dibuja el PDF, con su posición, ancho, alto y alineación.
 * La hora de "Generado el …" depende de la versión de ICU de Node: se quita.
 */
async function textosDelPdf(pages: AvancePage[]): Promise<TextoPdf[]> {
  const textos: TextoPdf[] = [];
  await espiarTextos(pages, (_doc, s, x, y, opts) => {
    textos.push([
      s.replace(/Generado el .* \(hora del centro\)/, 'Generado el …'),
      r2(x),
      r2(y),
      r2(opts?.width),
      r2(opts?.height),
      opts?.align ?? null,
    ]);
  });
  return textos;
}

/** Cada texto con lo que necesita (alto y ancho) para revisar que quepa. */
async function textosMedidos(pages: AvancePage[]): Promise<TextoMedido[]> {
  const textos: TextoMedido[] = [];
  await espiarTextos(pages, (doc, s, x, y, opts) => {
    const lineGap = opts?.lineGap ?? 0;
    const renglon = doc.currentLineHeight(true);
    const dibujado = doc.heightOfString(s, {
      width: opts?.width ?? doc.widthOfString(s) + 1,
      lineGap,
    });
    const renglones = Math.round(dibujado / (renglon + lineGap));
    textos.push({
      texto: s,
      x,
      y,
      alto: opts?.height,
      dibujado,
      necesita:
        renglones > 1
          ? Math.max(dibujado, renglones * renglon + (renglones - 2) * lineGap)
          : dibujado,
      largo: doc.widthOfString(s),
    });
  });
  return textos;
}

/** Los textos dentro de un rectángulo de la página. */
const dentro = (
  textos: TextoMedido[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) => textos.filter((t) => t.x >= x0 && t.x < x1 && t.y >= y0 && t.y < y1);

const valores = (c: GruposConteo): Record<GrupoClave, number> =>
  Object.fromEntries(c.grupos.map((g) => [g.clave, g.valor])) as Record<
    GrupoClave,
    number
  >;

const suma = (c: GruposConteo) => c.grupos.reduce((s, g) => s + g.valor, 0);

const pageCount = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;

function makeService() {
  // Sin datos: cada consulta regresa vacío
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
  return new AvanceSemanalService(prisma as unknown as PrismaService);
}

const maximoDefault = buildAvancePage(DATA, LUNES, 'maximo', NOW);
const sapDefault = buildAvancePage(DATA, LUNES, 'sap', NOW);
const maximoContrato = buildAvancePage(
  DATA,
  LUNES,
  'maximo',
  NOW,
  AVANCE_OPCIONES,
  'contrato',
);

describe('L2: sin el parámetro, la página sale igual que antes (JSON y PDF)', () => {
  it('el default espera a Jorge/Ingrid: estandar; AVANCE_REGLAS es la de O1 (viernes y hábiles)', () => {
    expect(AVANCE_GRUPOS_MAXIMO).toBe('estandar');
    expect(AVANCE_REGLAS).toEqual({
      recibida: 'aprobacion',
      dias_desde: 'aprobacion',
      cerrada: 'primera_oc_o_close',
      cancelada: 'can_historial',
      corte: 'viernes',
      dias_tipo: 'habiles',
    });
  });

  it('JSON: las páginas por defecto de Maximo y SAP son idénticas a las de antes', () => {
    expect(huella(maximoDefault)).toBe('75bc004edeb725d1');
    expect(huella(sapDefault)).toBe('922a018d0043e08c');
    // lo mismo, legible: sin la llave `grupos` y con el medidor de siempre
    expect(Object.keys(maximoDefault)).toEqual([
      'semana',
      'fuente',
      'opciones',
      'avance',
      'cierre',
      'cancelacion',
      'estado_anio',
      'anual',
      'montos',
      'por_sistema',
      'no_disponible',
      'notas',
      'generado',
    ]);
    expect(maximoDefault).not.toHaveProperty('grupos');
    expect(maximoDefault.estado_anio).toEqual({
      recibidas: 9,
      cerradas: 5,
      cerradas_sin_oc: 2,
      cerradas_sin_oc_ni_contrato: 1,
      cerradas_de_contrato: 2,
      canceladas: 2,
      abiertas: 2,
      atendidas: 7,
      atendidas_pct: 77.8,
    });
    // pedir 'estandar' explícito da la misma página
    expect(
      buildAvancePage(DATA, LUNES, 'maximo', NOW, AVANCE_OPCIONES, 'estandar'),
    ).toEqual(maximoDefault);
    expect(avanceDefiniciones('maximo')).not.toHaveProperty('grupos');
  });

  it('PDF: los textos (con su posición) de las páginas por defecto no cambian', async () => {
    const maximo = await textosDelPdf([maximoDefault]);
    const sap = await textosDelPdf([sapDefault]);
    // O1: la leyenda de las recibidas es un texto más en la de Maximo
    expect(maximo).toHaveLength(145);
    expect(huella(maximo)).toBe('eacb816715363e81');
    expect(sap).toHaveLength(132);
    expect(huella(sap)).toBe('94d58aa38c258a2b');
    // lo mismo, legible: la dona, los medidores y las barras de siempre
    const textos = maximo.map(([texto]) => texto);
    const dona = textos.indexOf('Recibidas 2026 por estado');
    expect(textos.slice(dona, dona + 9)).toEqual([
      'Recibidas 2026 por estado',
      '77.8%',
      'atendidas',
      'Cerradas',
      '5 · 55.6%',
      'Canceladas',
      '2 · 22.2%',
      'Abiertas',
      '2 · 22.2%',
    ]);
    expect(textos).toContain(
      'Comparación anual: gestiones recibidas contra atendidas (cerradas + canceladas)',
    );
    expect(textos).toContain('5 cerradas · 2 canceladas\n2 abiertas');
    expect(textos).toContain('Atendidas');
    // nada de los grupos nuevos (O1 sí dice "sin las de contrato" en los
    // montos: no es un grupo)
    expect(textos.join(' ')).not.toMatch(
      /OC automática|Cerradas sin contrato|[Cc]anceladas en Maximo/,
    );
  });
});

describe('L2: grupos=contrato en la página de Maximo', () => {
  it('la PR de contrato cerrada cuenta en "De contrato (OC automática)" y no en "Cerradas"; la CAN, en "Canceladas en Maximo"', () => {
    const recibida = T('2026-09-01T15:00:00Z');
    const contrato = pr('PR-1', {
      recibida,
      primera_oc: T('2026-09-02T15:00:00Z'),
      de_contrato: true,
    });
    const can = pr('PR-2', { recibida, cancelada: T('2026-09-03T15:00:00Z') });
    const datos: AvanceData = {
      gestiones: [contrato, can],
      ordenes: [],
      maximo_no_recibidas: [],
      sap_desde: null,
    };
    const page = buildAvancePage(
      datos,
      LUNES,
      'maximo',
      NOW,
      AVANCE_OPCIONES,
      'contrato',
    );
    const grupos = page.grupos!.estado_anio;
    expect(grupos.grupos.map((g) => [g.etiqueta, g.valor])).toEqual([
      ['Cerradas sin contrato', 0],
      ['De contrato (OC automática)', 1],
      ['Canceladas en Maximo', 1],
      ['Abiertas', 0],
    ]);
    // los KPIs no cambian: la de contrato sigue cerrada, la CAN cancelada
    expect(page.estado_anio).toMatchObject({
      recibidas: 2,
      cerradas: 1,
      canceladas: 1,
      atendidas: 2,
    });
    // la misma PR sin contrato cuenta en Cerradas sin contrato
    const sinContrato = buildAvancePage(
      { ...datos, gestiones: [{ ...contrato, de_contrato: false }, can] },
      LUNES,
      'maximo',
      NOW,
      AVANCE_OPCIONES,
      'contrato',
    );
    expect(valores(sinContrato.grupos!.estado_anio)).toEqual({
      cerradas_sin_contrato: 1,
      de_contrato: 0,
      canceladas: 1,
      abiertas: 0,
    });
  });

  it('con el fixture: 3 cerradas sin contrato + 2 de contrato + 2 canceladas en Maximo (una de contrato) + 2 abiertas = 9; por año igual', () => {
    const g = maximoContrato.grupos!;
    expect(g.modo).toBe('contrato');
    expect(g.estado_anio.recibidas).toBe(9);
    expect(
      g.estado_anio.grupos.map((x) => [x.clave, x.etiqueta, x.valor, x.pct]),
    ).toEqual([
      ['cerradas_sin_contrato', 'Cerradas sin contrato', 3, 33.3],
      ['de_contrato', 'De contrato (OC automática)', 2, 22.2],
      ['canceladas', 'Canceladas en Maximo', 2, 22.2],
      ['abiertas', 'Abiertas', 2, 22.2],
    ]);
    // las cerradas del KPI (tarjeta de avance) = sin contrato + de contrato
    expect(maximoContrato.avance.cerradas_anio).toBe(3 + 2);
    const anio = (s: number, c: number, x: number, a: number) => ({
      cerradas_sin_contrato: s,
      de_contrato: c,
      canceladas: x,
      abiertas: a,
    });
    expect(g.anual.map((a) => [a.anio, a.recibidas, valores(a)])).toEqual([
      [2022, 0, anio(0, 0, 0, 0)],
      [2023, 0, anio(0, 0, 0, 0)],
      [2024, 1, anio(0, 1, 0, 0)],
      [2025, 4, anio(1, 1, 1, 1)],
      [2026, 9, anio(3, 2, 2, 2)],
    ]);
    // sin recibidas, sin porcentaje
    expect(g.anual[0].grupos.every((x) => x.pct === null)).toBe(true);
  });

  it('identidad: recibidas = suma de los grupos en cada año y en cada corte', () => {
    for (const semana of [
      '2025-12-29',
      '2026-01-05',
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
    ]) {
      const page = buildAvancePage(
        DATA,
        D(semana),
        'maximo',
        NOW,
        AVANCE_OPCIONES,
        'contrato',
      );
      const g = page.grupos!;
      expect(g.estado_anio.recibidas).toBe(page.estado_anio.recibidas);
      expect(suma(g.estado_anio)).toBe(page.estado_anio.recibidas);
      expect(g.anual.map((a) => a.anio)).toEqual(page.anual.map((c) => c.anio));
      g.anual.forEach((a, i) => {
        expect(a.recibidas).toBe(page.anual[i].recibidas);
        expect(suma(a)).toBe(page.anual[i].recibidas);
        // y las atendidas del KPI son las de los tres primeros grupos
        expect(a.recibidas - valores(a).abiertas).toBe(page.anual[i].atendidas);
      });
    }
  });

  it('los KPIs y sus nombres no cambian: fuera de `grupos` y de la nota de las cerradas sin OC, la página es la misma', () => {
    const { grupos, notas, ...resto } = maximoContrato;
    const { notas: notasDefault, ...restoDefault } = maximoDefault;
    expect(grupos?.modo).toBe('contrato');
    expect(resto).toEqual(restoDefault);
    // la nota de las cerradas sin OC dice en qué grupo va cada una (las de
    // contrato no están en "Cerradas sin contrato"); las demás, iguales
    const vieja =
      '2 PR cerradas en Maximo sin OC (1 sin contrato): cuentan como cerradas, sin días.';
    expect(notasDefault).toContain(vieja);
    expect(notas).toEqual(
      notasDefault.map((n) =>
        n === vieja
          ? '2 PR cerradas en Maximo sin OC (sin días): 1 va en Cerradas sin contrato y 1 en De contrato (OC automática).'
          : n,
      ),
    );
    // la llave va junto al medidor y los años
    expect(Object.keys(maximoContrato)).toEqual([
      'semana',
      'fuente',
      'opciones',
      'avance',
      'cierre',
      'cancelacion',
      'estado_anio',
      'anual',
      'grupos',
      'montos',
      'por_sistema',
      'no_disponible',
      'notas',
      'generado',
    ]);
  });

  it('la nota de las cerradas sin OC con grupos: un solo grupo, varios, o ninguna', () => {
    const nota = (gestiones: Gestion[]) =>
      buildAvancePage(
        { ...DATA, gestiones },
        LUNES,
        'maximo',
        NOW,
        AVANCE_OPCIONES,
        'contrato',
      ).notas.filter((n) => n.includes('sin OC'));
    const close = (folio: string, deContrato: boolean) =>
      pr(folio, {
        recibida: T('2026-09-01T15:00:00Z'),
        cierre_sin_oc: T('2026-09-02T15:00:00Z'),
        de_contrato: deContrato,
      });
    expect(nota([close('PR-1', true)])).toEqual([
      '1 PR cerrada en Maximo sin OC (sin días) va en De contrato (OC automática).',
    ]);
    expect(nota([close('PR-1', false), close('PR-2', false)])).toEqual([
      '2 PR cerradas en Maximo sin OC (sin días) van en Cerradas sin contrato.',
    ]);
    expect(
      nota([close('PR-1', false), close('PR-2', true), close('PR-3', true)]),
    ).toEqual([
      '3 PR cerradas en Maximo sin OC (sin días): 1 va en Cerradas sin contrato y 2 en De contrato (OC automática).',
    ]);
    // sin cerradas sin OC, sin nota
    expect(nota([pr('PR-1', { recibida: T('2026-09-01T15:00:00Z') })])).toEqual(
      [],
    );
  });

  it('la página de SAP y la combinada no cambian con el parámetro', () => {
    for (const fuente of ['sap', 'todas'] as const) {
      const con = buildAvancePage(
        DATA,
        LUNES,
        fuente,
        NOW,
        AVANCE_OPCIONES,
        'contrato',
      );
      expect(con).not.toHaveProperty('grupos');
      expect(con).toEqual(buildAvancePage(DATA, LUNES, fuente, NOW));
      expect(avanceDefiniciones(fuente, AVANCE_OPCIONES, 'contrato')).toEqual(
        avanceDefiniciones(fuente),
      );
    }
  });

  it('definiciones: la de Maximo explica los grupos sin llamar "canceladas" a las de contrato; las demás no cambian', () => {
    const def = avanceDefiniciones('maximo', AVANCE_OPCIONES, 'contrato');
    const { grupos, ...resto } = def;
    expect(resto).toEqual(avanceDefiniciones('maximo'));
    expect(grupos).toContain(
      'Cerradas sin contrato = PR sin contrato cerradas al corte',
    );
    expect(grupos).toContain(
      'De contrato (OC automática) = PR con contrato cerradas al corte',
    );
    expect(grupos).toContain(
      'Canceladas en Maximo = PR canceladas en Maximo (última CAN de su historial), con o sin contrato',
    );
    expect(grupos).toContain('Los cuatro suman las recibidas');
    // y cuadra las dos cifras de cerradas de la página
    expect(grupos).toContain(
      'las cerradas de la tarjeta de avance son cerradas sin contrato + de contrato (OC automática)',
    );
  });
});

describe('L2: PDF con grupos', () => {
  afterEach(() => jest.restoreAllMocks());

  it('la dona, los medidores, la banda y las barras muestran los grupos sin encimarse ni cortarse', async () => {
    const textos = await textosMedidos([maximoContrato]);
    const solo = (lista: TextoMedido[]) => lista.map((t) => t.texto);

    // Dona (tarjeta de 608 a 770 × 96 a 318): cuatro grupos; las etiquetas
    // largas en dos renglones, cortadas antes del paréntesis o en el primer
    // espacio
    const dona = dentro(textos, 608, 96, 770, 318);
    expect(solo(dona)).toEqual([
      'Recibidas 2026 por estado',
      '77.8%',
      'atendidas',
      'Cerradas',
      '3 · 33.3%',
      'sin contrato',
      'De contrato',
      '2 · 22.2%',
      '(OC automática)',
      'Canceladas',
      '2 · 22.2%',
      'en Maximo',
      'Abiertas',
      '2 · 22.2%',
    ]);
    // la leyenda: cada renglón debajo del anterior, en un solo renglón y
    // dentro de la tarjeta; las etiquetas no llegan a la columna de valores
    // (alineada a la derecha en 756; "1,385 · 63.5%" mide 47 pt)
    const leyenda = dona.slice(3).filter((t) => !t.texto.includes('·'));
    leyenda.forEach((t, i) => {
      expect(t.necesita).toBeLessThanOrEqual(12);
      if (i > 0) expect(t.y - leyenda[i - 1].y).toBeGreaterThanOrEqual(10);
      expect(t.x + t.largo).toBeLessThanOrEqual(756 - 50);
    });
    expect(leyenda[leyenda.length - 1].y + 11.25).toBeLessThanOrEqual(318 - 4);

    // Medidores: un renglón por grupo (sin el paréntesis, como la banda), sin
    // "…" y sin pisar el medidor de abajo
    const detalles = textos.filter((t) =>
      / abiertas$|^Sin gestiones$/.test(t.texto),
    );
    const renglones = (s: number, c: number, x: number, a: number) =>
      `${s} cerradas sin contrato\n${c} de contrato\n${x} canceladas en Maximo\n${a} abiertas`;
    expect(solo(detalles)).toEqual([
      'Sin gestiones',
      renglones(0, 1, 0, 0),
      renglones(1, 1, 1, 1),
      renglones(3, 2, 2, 2),
    ]);
    for (const t of detalles) {
      expect(t.alto).toBeDefined();
      expect(t.necesita).toBeLessThanOrEqual(t.alto!);
      expect(t.y + t.dibujado).toBeLessThanOrEqual(356 + 198 - 4);
    }
    // el de 2024 (arriba, cuatro renglones) termina antes del arco de abajo,
    // que empieza 14 pt arriba de su % (2025: "75%")
    const pct2025 = textos.find((t) => t.texto === '75%')!;
    expect(detalles[1].y + detalles[1].dibujado).toBeLessThanOrEqual(
      pct2025.y - 14,
    );

    // Banda: en un renglón, con los nombres de los grupos
    const banda = textos.find((t) => t.texto.startsWith('Comparación anual'))!;
    expect(banda.texto).toBe(
      'Comparación anual: gestiones recibidas contra atendidas (cerradas sin contrato + de contrato + canceladas en Maximo)',
    );
    expect(banda.dibujado).toBeLessThanOrEqual(9.5 * 1.5);

    // Barras (tarjeta de 502 a 770): la leyenda nombra los grupos, cabe en
    // la tarjeta y queda arriba de las cifras de las barras
    const barras = dentro(textos, 502, 356, 770, 554);
    const etiquetas = [
      'Recibidas',
      'Cerradas sin contrato',
      'De contrato (OC automática)',
      'Canceladas en Maximo',
    ];
    const leyendaBarras = barras.filter((t) => etiquetas.includes(t.texto));
    expect(solo(leyendaBarras)).toEqual(etiquetas);
    for (const t of leyendaBarras) {
      expect(t.x + t.largo).toBeLessThanOrEqual(502 + 268 - 14);
    }
    const ultimaLeyenda = Math.max(...leyendaBarras.map((t) => t.y));
    // las cifras de las barras (arriba del eje, en 534; abajo van los años)
    const cifras = barras.filter(
      (t) => /^\d[\d,]*$/.test(t.texto) && t.y < 356 + 198 - 20,
    );
    expect(cifras.length).toBe(10);
    expect(Math.min(...cifras.map((t) => t.y))).toBeGreaterThan(
      ultimaLeyenda + 9,
    );

    // Ningún texto con tope de alto se corta con "…"
    for (const t of textos.filter((x) => x.alto !== undefined)) {
      expect(t.necesita).toBeLessThanOrEqual(t.alto! + 0.01);
    }
  });

  it('con cifras de tres y cuatro dígitos todo cabe: un grupo por renglón en los medidores y la leyenda de la dona sin encimarse con los valores', async () => {
    const varias = (
      n: number,
      anio: number,
      o: Partial<Gestion>,
      folio: string,
    ): Gestion[] =>
      Array.from({ length: n }, (_, i) =>
        pr(`${folio}${anio}-${i}`, {
          recibida: T(`${anio}-09-01T15:00:00Z`),
          ...o,
        }),
      );
    const evento = (anio: number) => T(`${anio}-09-05T15:00:00Z`);
    const gestiones = [2025, 2026].flatMap((anio) => {
      // 2026 con cuatro dígitos; 2025 con tres
      const k = anio === 2026 ? 1 : 0;
      return [
        ...varias(397 + k * 1000, anio, { primera_oc: evento(anio) }, 'S'),
        ...varias(
          121 + k * 1000,
          anio,
          { primera_oc: evento(anio), de_contrato: true },
          'C',
        ),
        ...varias(151 + k * 1000, anio, { cancelada: evento(anio) }, 'X'),
        ...varias(169, anio, {}, 'A'),
      ];
    });
    const page = buildAvancePage(
      { ...DATA, gestiones },
      LUNES,
      'maximo',
      NOW,
      AVANCE_OPCIONES,
      'contrato',
    );
    expect(valores(page.grupos!.estado_anio)).toEqual({
      cerradas_sin_contrato: 1397,
      de_contrato: 1121,
      canceladas: 1151,
      abiertas: 169,
    });
    const textos = await textosMedidos([page]);
    // medidores: cuatro renglones exactos (ninguno se parte) y sin "…"
    const detalles = textos.filter((t) => / abiertas$/.test(t.texto));
    expect(detalles.map((t) => t.texto)).toEqual([
      '397 cerradas sin contrato\n121 de contrato\n151 canceladas en Maximo\n169 abiertas',
      '1,397 cerradas sin contrato\n1,121 de contrato\n1,151 canceladas en Maximo\n169 abiertas',
    ]);
    for (const t of detalles) {
      expect(t.dibujado).toBeCloseTo(4 * (9.45 - 1.4), 5);
      expect(t.necesita).toBeLessThanOrEqual(t.alto!);
    }
    // dona: cada valor a la derecha de su etiqueta, sin tocarla
    const dona = dentro(textos, 608, 96, 770, 318).slice(3);
    for (let i = 0; i < dona.length; i += 1) {
      const t = dona[i];
      if (!t.texto.includes('·')) continue;
      const etiqueta = dona[i - 1];
      expect(etiqueta.y).toBe(t.y);
      expect(etiqueta.x + etiqueta.largo).toBeLessThanOrEqual(
        756 - t.largo - 3,
      );
    }
    expect(dona.map((t) => t.texto)).toContain('1,397 · 36.4%');
  });

  it('las demás tarjetas son las de siempre (la tarjeta de avance sigue diciendo sus cerradas); la página de SAP del mismo reporte no cambia', async () => {
    const con = await textosDelPdf([maximoContrato]);
    const sin = await textosDelPdf([maximoDefault]);
    // fuera de la dona, la banda, los medidores, las barras y las notas
    // del pie, igual
    const fuera = (lista: TextoPdf[]) =>
      lista.filter(
        ([, x, y]) =>
          !(x! >= 608 && y! >= 96 && y! < 318) &&
          !(y! >= 326 && y! < 348) &&
          !(x! < 264 && y! >= 356 && y! < 554) &&
          !(x! >= 502 && y! >= 356 && y! < 554) &&
          !(y! >= 560 && y! < 588),
      );
    expect(fuera(con)).toEqual(fuera(sin));
    expect(con.map(([t]) => t)).toContain('cerradas de las recibidas en 2026');
    // el pie: solo cambia la nota de las cerradas sin OC
    const pie = (lista: TextoPdf[]) => lista.find(([, , y]) => y === 562)![0];
    expect(pie(con)).toBe(
      pie(sin).replace(
        '2 PR cerradas en Maximo sin OC (1 sin contrato): cuentan como cerradas, sin días.',
        '2 PR cerradas en Maximo sin OC (sin días): 1 va en Cerradas sin contrato y 1 en De contrato (OC automática).',
      ),
    );
    expect(pie(con)).not.toBe(pie(sin));
    const sapCon = buildAvancePage(
      DATA,
      LUNES,
      'sap',
      NOW,
      AVANCE_OPCIONES,
      'contrato',
    );
    expect(huella(await textosDelPdf([sapCon]))).toBe(
      huella(await textosDelPdf([sapDefault])),
    );
  });

  it('sin recibidas en el año: la dona con grupos sale vacía (sin errores) y dice 0 en cada grupo', async () => {
    const vacia = buildAvancePage(
      { ...DATA, gestiones: [] },
      LUNES,
      'maximo',
      NOW,
      AVANCE_OPCIONES,
      'contrato',
    );
    expect(vacia.grupos!.estado_anio.grupos.map((g) => g.pct)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    const textos = (await textosDelPdf([vacia])).map(([t]) => t);
    expect(textos.filter((t) => t === '0 · 0%')).toHaveLength(4);
    expect(textos.filter((t) => t === 'Sin gestiones')).toHaveLength(4);
  });
});

describe('L2: parámetro grupos (DTO, JSON y PDF)', () => {
  it('el DTO acepta grupos=contrato (no lo descarta el whitelist) y estandar, y rechaza otro valor', async () => {
    // espejo de main.ts
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const meta = {
      type: 'query' as const,
      metatype: AvanceSemanalDto,
      data: '',
    };
    expect(
      await pipe.transform({ semana: '2026-09-21', grupos: 'contrato' }, meta),
    ).toEqual({ semana: '2026-09-21', grupos: 'contrato' });
    expect(await pipe.transform({ grupos: 'estandar' }, meta)).toEqual({
      grupos: 'estandar',
    });
    // sin el parámetro: no viene (el servicio usa la constante)
    const vacio = (await pipe.transform({}, meta)) as AvanceSemanalDto;
    expect(vacio.grupos).toBeUndefined();
    for (const malo of ['CONTRATO', 'canceladas', 'contratos', '']) {
      await expect(pipe.transform({ grupos: malo }, meta)).rejects.toThrow(
        BadRequestException,
      );
    }
  });

  it('JSON: con grupos=contrato la página de Maximo trae sus grupos y su definición; la de SAP no; sin el parámetro, ninguna', async () => {
    type Pagina = AvancePage & { definiciones: Record<string, string> };
    const resumen = (r: unknown) =>
      (r as { paginas: Pagina[] }).paginas.map((p) => [
        p.fuente.clave,
        p.grupos?.modo ?? null,
        'grupos' in p,
        'grupos' in p.definiciones,
      ]);
    expect(
      resumen(
        await makeService().getSemana({
          semana: '2026-09-21',
          grupos: 'contrato',
        }),
      ),
    ).toEqual([
      ['maximo', 'contrato', true, true],
      ['sap', null, false, false],
    ]);
    expect(
      resumen(await makeService().getSemana({ semana: '2026-09-21' })),
    ).toEqual([
      ['maximo', null, false, false],
      ['sap', null, false, false],
    ]);
    const soloMaximo = (await makeService().getSemana({
      semana: '2026-09-21',
      fuente: 'maximo',
      grupos: 'contrato',
    })) as Pagina;
    expect(soloMaximo.grupos?.modo).toBe('contrato');
  });

  it('PDF: la semana y el acumulado pasan los grupos a cada página de Maximo; el nombre del archivo lo dice', async () => {
    const pages = await makeService().getPaginas({
      desde: '2026-09-07',
      hasta: '2026-09-21',
      grupos: 'contrato',
    });
    expect(
      pages.map(
        (p) => `${p.fuente.clave} ${p.semana.lunes} ${p.grupos?.modo ?? '-'}`,
      ),
    ).toEqual([
      'maximo 2026-09-21 contrato',
      'maximo 2026-09-14 contrato',
      'maximo 2026-09-07 contrato',
      'sap 2026-09-21 -',
      'sap 2026-09-14 -',
      'sap 2026-09-07 -',
    ]);
    const conGrupos = await makeService().buildPdf({
      semana: '2026-09-21',
      grupos: 'contrato',
    });
    expect(conGrupos.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(conGrupos.buffer)).toBe(2);
    expect(conGrupos.filename).toBe(
      'reporte_avance_semanal_2026-09-21_grupos_contrato.pdf',
    );
    // sin el parámetro (o con el default explícito), el nombre de siempre
    for (const dto of [
      { semana: '2026-09-21' },
      { semana: '2026-09-21', grupos: 'estandar' as const },
    ]) {
      expect((await makeService().buildPdf(dto)).filename).toBe(
        'reporte_avance_semanal_2026-09-21.pdf',
      );
    }
    expect(
      (
        await makeService().buildPdf({
          desde: '2026-09-14',
          hasta: '2026-09-21',
          fuente: 'maximo',
          grupos: 'contrato',
        })
      ).filename,
    ).toBe(
      'reporte_avance_semanal_2026-09-14_al_2026-09-21_maximo_grupos_contrato.pdf',
    );
    // sin página de Maximo (SAP o la combinada), los grupos no cambian nada
    // y el nombre tampoco lo dice
    for (const [fuente, nombre] of [
      ['sap', 'reporte_avance_semanal_2026-09-21_sap.pdf'],
      ['todas', 'reporte_avance_semanal_2026-09-21_combinado.pdf'],
    ] as const) {
      expect(
        (
          await makeService().buildPdf({
            semana: '2026-09-21',
            fuente,
            grupos: 'contrato',
          })
        ).filename,
      ).toBe(nombre);
    }
  });
});
