import 'reflect-metadata';
import { createHash } from 'crypto';
import PDFDocument from 'pdfkit';
import {
  type AvanceData,
  avanceDefiniciones,
  type AvancePage,
  buildAvancePage,
  type Gestion,
} from './avance-semanal.engine';
import { renderAvancePdf } from './avance-semanal.pdf';
import { AVANCE_REGLAS } from './avance-semanal.reglas';

/**
 * Huellas de las páginas por defecto (JSON y PDF): fijan que un cambio que
 * no debía tocar la página no la tocó.
 *
 * Historia: nacieron en L2 (2026-10-08, api `98c27e0`) para probar que sin
 * `grupos` la página salía igual; O1 (2026-10-26) las recalculó a propósito
 * (viernes, hábiles, montos con IVA sin contrato, leyenda y promedio del
 * título). O2 (2026-11-17) quitó L2 y agregó las RQ: la página de PR sale
 * IGUAL que en O1, JSON y PDF (`gestion_maximo` solo existe con las RQ).
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
 * Semana del 21-sep-2026. Recibidas de Maximo en 2026: 9 (las mismas PR que
 * usaba L2: con y sin contrato, cerradas con OC y por CLOSE, canceladas y
 * abiertas), más 2025 y 2024, y tres solicitudes de SAP.
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
  pr('PR-N', {
    recibida: T('2024-03-01T15:00:00Z'),
    cierre_sin_oc: T('2024-03-02T15:00:00Z'),
    de_contrato: true,
  }),
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

/**
 * Cada texto que dibuja el PDF, con su posición, ancho, alto y alineación.
 * La hora de "Generado el …" depende de la versión de ICU de Node: se quita.
 */
async function textosDelPdf(pages: AvancePage[]): Promise<TextoPdf[]> {
  const textos: TextoPdf[] = [];
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
      { width?: number; height?: number; align?: string } | undefined,
    ];
    if (typeof s === 'string') {
      textos.push([
        s.replace(/Generado el .* \(hora del centro\)/, 'Generado el …'),
        r2(x),
        r2(y),
        r2(opts?.width),
        r2(opts?.height),
        opts?.align ?? null,
      ]);
    }
    return original.apply(this, args);
  });
  try {
    await renderAvancePdf(pages);
  } finally {
    spy.mockRestore();
  }
  return textos;
}

const maximoDefault = buildAvancePage(DATA, LUNES, 'maximo', NOW);
const sapDefault = buildAvancePage(DATA, LUNES, 'sap', NOW);

describe('huellas: las páginas por defecto no cambian (JSON y PDF)', () => {
  it('AVANCE_REGLAS es la de O1 (viernes y hábiles)', () => {
    expect(AVANCE_REGLAS).toEqual({
      recibida: 'aprobacion',
      dias_desde: 'aprobacion',
      cerrada: 'primera_oc_o_close',
      cancelada: 'can_historial',
      corte: 'viernes',
      dias_tipo: 'habiles',
    });
  });

  it('JSON: las páginas de PR de Maximo y de SAP son las de O1', () => {
    expect(huella(maximoDefault)).toBe('75bc004edeb725d1');
    expect(huella(sapDefault)).toBe('922a018d0043e08c');
    // O2: sin la llave de las RQ
    expect(maximoDefault).not.toHaveProperty('gestion_maximo');
    expect(sapDefault).not.toHaveProperty('gestion_maximo');
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
    // L2 ya no existe
    expect(maximoDefault).not.toHaveProperty('grupos');
    expect(avanceDefiniciones('maximo')).not.toHaveProperty('grupos');
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
  });

  it('PDF: los textos (con su posición) de las páginas por defecto no cambian', async () => {
    const maximo = await textosDelPdf([maximoDefault]);
    const sap = await textosDelPdf([sapDefault]);
    // O1: la leyenda de las recibidas es un texto más en la de Maximo
    expect(maximo).toHaveLength(145);
    expect(huella(maximo)).toBe('eacb816715363e81');
    expect(sap).toHaveLength(132);
    expect(huella(sap)).toBe('94d58aa38c258a2b');
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
  });

  it('O2: con las gestiones de Maximo sobre RQ, la página de SAP sale idéntica', () => {
    const conRq: AvanceData = {
      ...DATA,
      maximo_gestion: 'rq',
      maximo_no_recibidas: [],
      gestiones: [
        ...GESTIONES.filter((g) => g.sistema === 'sap'),
        {
          ...pr('RQ1', { recibida: T('2026-09-02T15:00:00Z') }),
          fecha_origen: 'rq',
          historial: [{ fecha: T('2026-09-02T15:00:00Z'), estado: 'abierta' }],
        },
      ],
    };
    expect(buildAvancePage(conRq, LUNES, 'sap', NOW)).toEqual(sapDefault);
  });
});
