import type { Buyer } from '../common/utils/buyer.util';
import {
  type AdjudicadoEntry,
  type AhorroEntry,
  ahorroPorComprador,
  buildAdjudicado,
  buildAhorro,
  buildBuyerMark,
  buildGestionAmbos,
  buildGestionPorComprador,
  buildPersonDirectory,
  buyerKey,
  COMPRADORES_SAP,
  compradorAviso,
  compradoresAdjudicado,
  groupByBuyer,
  type GestionPorComprador,
  isMarkedBuyer,
  type KpiBuyer,
  maximoGestionPorComprador,
  maximoKpiBuyer,
  MIN_OC_GESTION,
  OC_DE_CONTRATO,
  sapBuyer,
  sapGestionPorComprador,
  sapKpiBuyer,
  sortGestion,
  sumByCurrency,
} from './buyer-kpis';
import { maximoGestion, sapGestionDays } from './sap-gestion-days';

/**
 * Bloque M (2026-10-14, Ingrid) — funciones puras de los KPIs por comprador
 * de Órdenes: M1 ahorro y M2 días de gestión (G2). La regla del comprador es
 * E4/F1; aquí se pinza cómo se junta a la misma persona, el tipo
 * ("comprador" o "capturó"), el orden de las barras y que las cuentas
 * cuadran con la tarjeta y el tablero.
 *
 * Bloque N (2026-10-16): la persona ligada a su perfil, adjudicado y ahorro
 * por persona (N1) y gestiones de "Ambos" sistemas (N2).
 */
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const comprador = (name: string): Buyer => ({ name, kind: 'comprador' });
const capturo = (name: string): Buyer => ({ name, kind: 'capturo' });
const nadie: Buyer = { name: null, kind: null };

const ahorro = (
  fuente: AhorroEntry['fuente'],
  buyer: Buyer,
  currency: string | null,
  total: number,
  count = 1,
): AhorroEntry => ({ fuente, buyer, currency, total, count });

describe('buyerKey (M1/M2)', () => {
  it('junta a la misma persona: sin acentos, en minúsculas y sin espacios de más', () => {
    expect(buyerKey('Ingrid Torres GUTIÉRREZ')).toBe('ingrid torres gutierrez');
    expect(buyerKey('  Ingrid  Torres Gutiérrez ')).toBe(
      buyerKey('Ingrid Torres GUTIÉRREZ'),
    );
    expect(buyerKey('Ana Pérez')).not.toBe(buyerKey('Ana Ramírez'));
  });

  it('sin nombre (null, vacío o solo espacios) → null: "Sin comprador identificado"', () => {
    expect(buyerKey(null)).toBeNull();
    expect(buyerKey(undefined)).toBeNull();
    expect(buyerKey('')).toBeNull();
    expect(buyerKey('   ')).toBeNull();
  });
});

describe('sapBuyer (E4)', () => {
  it('SAP no registra comprador: quien capturó la OC, como comprador inferido; sin nombre → sin comprador', () => {
    expect(sapBuyer('Jorge Sandoval')).toEqual({
      name: 'Jorge Sandoval',
      kind: 'capturo',
    });
    expect(sapBuyer(null)).toEqual({ name: null, kind: null });
  });
});

describe('maximoKpiBuyer (O3: RQ › PURCHASEAGENT › sin comprador, con el alias)', () => {
  const aliases = new Map([
    ['JSANDOVAL', 'Jorge Sandoval'],
    ['AMONDRAG', 'Ana Aurora Mondragón'],
  ]);

  it('PURCHASEAGENT con alias → comprador, nombre del alias', () => {
    expect(
      maximoKpiBuyer(
        {
          purchase_agent: 'JSANDOVAL',
          purchase_agent_name: 'SANDOVAL JORGE',
          created_by: 'AMONDRAG',
        },
        aliases,
      ),
    ).toEqual({ name: 'Jorge Sandoval', kind: 'comprador', alias: true });
  });

  it('PURCHASEAGENT sin alias → su DISPLAYNAME, sin marca de alias (aunque el creador sí lo tenga)', () => {
    expect(
      maximoKpiBuyer(
        {
          purchase_agent: 'OTRO1',
          purchase_agent_name: 'Otro Comprador',
          created_by: 'AMONDRAG',
        },
        aliases,
      ),
    ).toEqual({ name: 'Otro Comprador', kind: 'comprador', alias: false });
  });

  it('O3: sin RQ ni PURCHASEAGENT → sin comprador, aunque alguien la haya creado ("Capturó" ya no cuenta)', () => {
    const nadieMx = { name: null, kind: null, alias: false };
    expect(
      maximoKpiBuyer(
        {
          purchase_agent: null,
          purchase_agent_name: null,
          created_by: 'AMONDRAG',
        },
        aliases,
      ),
    ).toEqual(nadieMx);
    expect(
      maximoKpiBuyer({ purchase_agent: '', created_by: 'VMM3' }, aliases),
    ).toEqual(nadieMx);
    expect(maximoKpiBuyer({}, aliases)).toEqual(nadieMx);
  });
});

describe('groupByBuyer', () => {
  it('nombre = la variante con más OC; en empate, la primera en orden alfabético', () => {
    const groups = groupByBuyer(
      [
        { buyer: capturo('ANA PÉREZ'), n: 1 },
        { buyer: capturo('Ana Pérez'), n: 3 },
        { buyer: capturo('JORGE  SANDOVAL'), n: 2 },
        { buyer: capturo('Jorge Sandoval'), n: 2 },
      ],
      (i) => i.buyer,
      (i) => i.n,
    );
    expect(groups.map((g) => [g.comprador, g.documentos])).toEqual([
      ['Ana Pérez', 4],
      // empate 2-2: 'Jorge Sandoval' va antes que 'JORGE SANDOVAL'
      ['Jorge Sandoval', 4],
    ]);
  });

  it('el nombre del alias de Compras gana aunque tenga menos OC ("el nombre es el del alias")', () => {
    const groups = groupByBuyer(
      [
        { buyer: capturo('JORGE SANDOVAL'), n: 10 },
        { buyer: { ...capturo('Jorge Sandoval'), alias: true }, n: 2 },
        { buyer: capturo('Ana Pérez'), n: 1 },
      ],
      (i) => i.buyer,
      (i) => i.n,
    );
    expect(groups.map((g) => [g.comprador, g.documentos])).toEqual([
      ['Jorge Sandoval', 12],
      ['Ana Pérez', 1],
    ]);
  });

  it('tipo mixto → "capturo" con cuántas OC son inferidas; sin nombre → grupo sin comprador (tipo null, sin inferidas)', () => {
    const groups = groupByBuyer(
      [
        { buyer: comprador('Ana Aurora Mondragón'), n: 6 },
        { buyer: capturo('ana aurora mondragon'), n: 4 },
        { buyer: comprador('Diana Yohara'), n: 5 },
        { buyer: nadie, n: 2 },
        // un nombre en blanco tampoco es comprador
        { buyer: capturo('  '), n: 1 },
      ],
      (i) => i.buyer,
      (i) => i.n,
    );
    expect(
      groups.map(({ comprador, tipo, documentos, documentos_capturo }) => ({
        comprador,
        tipo,
        documentos,
        documentos_capturo,
      })),
    ).toEqual([
      {
        comprador: 'Ana Aurora Mondragón',
        tipo: 'capturo',
        documentos: 10,
        documentos_capturo: 4,
      },
      {
        comprador: 'Diana Yohara',
        tipo: 'comprador',
        documentos: 5,
        documentos_capturo: 0,
      },
      { comprador: null, tipo: null, documentos: 3, documentos_capturo: 0 },
    ]);
  });
});

describe('M1: ahorro por comprador', () => {
  it('une "Ingrid Torres GUTIÉRREZ" (SAP) con "Ingrid Torres Gutiérrez" (alias de Maximo), por moneda y sin convertir', () => {
    const list = ahorroPorComprador([
      ahorro('sap', capturo('Ingrid Torres GUTIÉRREZ'), 'MXN', 100, 1),
      ahorro('maximo', capturo('Ingrid Torres Gutiérrez'), 'MXN', 50.5, 2),
      ahorro('maximo', comprador('Ingrid Torres Gutiérrez'), 'USD', 10, 1),
    ]);
    expect(list).toEqual([
      {
        // 3 OC con la variante de Maximo contra 1 con la de SAP
        comprador: 'Ingrid Torres Gutiérrez',
        grupo: 'persona',
        tipo: 'capturo',
        documentos: 4,
        documentos_capturo: 3,
        por_moneda: [
          { currency: 'MXN', total: 150.5, count: 3 },
          { currency: 'USD', total: 10, count: 1 },
        ],
      },
    ]);
  });

  it('orden: ahorro en MXN de mayor a menor, luego más OC; "Sin comprador identificado" al final aunque tenga más', () => {
    const list = ahorroPorComprador([
      ahorro('sap', nadie, 'MXN', 9999, 1),
      ahorro('sap', capturo('Beto'), 'MXN', 100, 1),
      ahorro('maximo', capturo('Carla'), 'MXN', 500, 1),
      ahorro('maximo', capturo('Ana'), 'MXN', 100, 3),
      // solo USD: sin MXN va después de los que tienen MXN
      ahorro('maximo', capturo('Dora'), 'USD', 1_000_000, 1),
    ]);
    expect(list.map((b) => b.comprador)).toEqual([
      'Carla',
      'Ana',
      'Beto',
      'Dora',
      null,
    ]);
  });

  it('sumByCurrency: a centavos (sin 0.30000000000000004), monedas aparte y la moneda nula como su propio renglón', () => {
    expect(
      sumByCurrency([
        { currency: 'MXN', total: 0.1, count: 1 },
        { currency: 'MXN', total: 0.2, count: 1 },
        { currency: null, total: 5, count: 1 },
        { currency: 'USD', total: 7, count: 2 },
        // un renglón sin OC no inventa la moneda
        { currency: 'EUR', total: 0, count: 0 },
      ]),
    ).toEqual([
      { currency: 'USD', total: 7, count: 2 },
      { currency: null, total: 5, count: 1 },
      { currency: 'MXN', total: 0.3, count: 2 },
    ]);
  });

  it('buildAhorro: la tarjeta y las barras salen de los mismos renglones (por moneda, Σ barras = tarjeta)', () => {
    const entries = [
      ahorro('sap', capturo('Jorge Sandoval'), 'MXN', 1000.1, 2),
      ahorro('sap', nadie, 'MXN', 0.2, 1),
      ahorro('maximo', comprador('Ana Aurora Mondragón'), 'MXN', 2000, 1),
      ahorro('maximo', capturo('JORGE SANDOVAL'), 'USD', 10.25, 1),
    ];
    const result = buildAhorro(entries);
    expect(result).toMatchObject({
      disponible: true,
      documentos: 5,
      por_moneda: [
        { currency: 'MXN', total: 3000.3, count: 4 },
        { currency: 'USD', total: 10.25, count: 1 },
      ],
      por_fuente: {
        sap: {
          documentos: 3,
          por_moneda: [{ currency: 'MXN', total: 1000.3, count: 3 }],
        },
        maximo: {
          documentos: 2,
          por_moneda: [
            { currency: 'MXN', total: 2000, count: 1 },
            { currency: 'USD', total: 10.25, count: 1 },
          ],
        },
      },
    });
    for (const card of result.por_moneda) {
      const bars = result.por_comprador.flatMap((b) =>
        b.por_moneda.filter((m) => m.currency === card.currency),
      );
      const total = Math.round(bars.reduce((s, m) => s + m.total, 0) * 100);
      expect(total / 100).toBe(card.total);
      expect(bars.reduce((s, m) => s + m.count, 0)).toBe(card.count);
    }
    expect(result.por_comprador.map((b) => b.comprador)).toEqual([
      'Ana Aurora Mondragón',
      'Jorge Sandoval',
      null,
    ]);
  });

  it('sin renglones (sin captura) → no disponible y sin barras (nunca una gráfica en 0)', () => {
    expect(buildAhorro([])).toEqual({
      disponible: false,
      documentos: 0,
      por_moneda: [],
      por_fuente: {
        sap: { documentos: 0, por_moneda: [] },
        maximo: { documentos: 0, por_moneda: [] },
      },
      por_comprador: [],
    });
  });
});

describe('M2: tiempo de gestión por comprador', () => {
  const requests = [
    { doc_entry: 100, doc_date: d('2026-03-01') },
    { doc_entry: 101, doc_date: d('2026-03-01') },
  ];
  const sapPo = (
    doc_entry: number,
    fecha: string,
    buyer: Buyer,
    base: number[] = [100],
  ) => ({
    doc_entry,
    doc_date: d(fecha),
    base_request_entries: base,
    buyer,
  });

  it('SAP: la cuenta de G2 por comprador; N ≥ 3 por promedio ascendente, luego los de N < 3, y sin comprador al final; N = 0 no sale', () => {
    const pos = [
      // Lenta (N = 3): 30, 30 y 30 días
      sapPo(1, '2026-03-31', capturo('Lenta')),
      sapPo(2, '2026-03-31', capturo('Lenta')),
      sapPo(3, '2026-03-31', capturo('Lenta')),
      // Rápida (N = 3): 2, 4 y 6 días; con dos variantes del nombre
      sapPo(4, '2026-03-03', capturo('Rápida')),
      sapPo(5, '2026-03-05', capturo('RAPIDA')),
      sapPo(6, '2026-03-07', capturo('Rápida')),
      // Poca (N = 1): 1 día, el más rápido, pero con menos de 3 OC
      sapPo(7, '2026-03-02', capturo('Poca')),
      // sin comprador: 1 día
      sapPo(8, '2026-03-02', nadie),
      // Fantasma: solo una negativa (descartada) → N = 0, no sale
      sapPo(9, '2026-02-01', capturo('Fantasma')),
    ];
    const list = sapGestionPorComprador(pos, requests);
    expect(
      list.map((g) => [g.comprador, g.promedio_dias, g.total, g.descartadas]),
    ).toEqual([
      ['Rápida', 4, 3, 0],
      ['Lenta', 30, 3, 0],
      ['Poca', 1, 1, 0],
      [null, 1, 1, 0],
    ]);
    // la suma por comprador cuadra con G2 del conjunto (Fantasma solo
    // descarta): (4·3 + 30·3 + 1 + 1) / 8 = 13
    const total = sapGestionDays(pos, requests);
    expect(total.promedio_dias).toBe(13);
    expect(list.reduce((s, g) => s + g.total, 0)).toBe(total.total);
    expect(
      list.reduce((s, g) => s + (g.promedio_dias ?? 0) * g.total, 0) /
        total.total,
    ).toBeCloseTo(total.promedio_dias ?? Number.NaN, 5);
    expect(list.reduce((s, g) => s + g.descartadas, 0)).toBe(
      total.descartadas - 1,
    );
  });

  it('SAP: el tipo y las inferidas cuentan solo las OC dentro de la N', () => {
    const list = sapGestionPorComprador(
      [
        sapPo(1, '2026-03-11', comprador('Ana Aurora Mondragón')),
        // inferida pero descartada (negativa): no vuelve "capturo" al grupo
        sapPo(2, '2026-02-11', capturo('Ana Aurora Mondragón')),
      ],
      requests,
    );
    expect(list).toEqual([
      {
        comprador: 'Ana Aurora Mondragón',
        grupo: 'persona',
        tipo: 'comprador',
        documentos_capturo: 0,
        promedio_dias: 10,
        mediana_dias: 10,
        total: 1,
        descartadas: 1,
      },
    ]);
  });

  it('Maximo: principal desde la creación de la PR y secundario desde su aprobación; tipo mixto con las inferidas dentro de la N', () => {
    const rows = [
      {
        dias: '12',
        dias_desde_aprobacion: '5',
        buyer: comprador('Ana Aurora Mondragón'),
      },
      {
        dias: '20',
        dias_desde_aprobacion: '10',
        buyer: capturo('Ana Aurora Mondragón'),
      },
      {
        dias: '16',
        dias_desde_aprobacion: null,
        buyer: capturo('ANA AURORA MONDRAGON'),
      },
      { dias: null, dias_desde_aprobacion: null, buyer: capturo('Víctor') },
      { dias: '7', dias_desde_aprobacion: '3', buyer: capturo('Víctor') },
    ];
    expect(maximoGestionPorComprador(rows)).toEqual([
      {
        comprador: 'Ana Aurora Mondragón',
        grupo: 'persona',
        tipo: 'capturo',
        documentos_capturo: 2,
        promedio_dias: 16,
        mediana_dias: 16,
        total: 3,
        descartadas: 0,
        sin_solicitud: 0,
        desde_aprobacion: { promedio_dias: 7.5, mediana_dias: 7.5, total: 2 },
      },
      {
        comprador: 'Víctor',
        grupo: 'persona',
        tipo: 'capturo',
        documentos_capturo: 1,
        promedio_dias: 7,
        mediana_dias: 7,
        total: 1,
        descartadas: 0,
        sin_solicitud: 1,
        desde_aprobacion: { promedio_dias: 3, mediana_dias: 3, total: 1 },
      },
    ]);
  });

  it('Maximo: un comprador sin N principal no sale; su dato desde la aprobación solo cuenta en el total del sistema', () => {
    const rows = [
      { dias: '9', dias_desde_aprobacion: '4', buyer: capturo('Ana') },
      // sin fecha de creación de la PR pero con aprobación (caso raro)
      { dias: null, dias_desde_aprobacion: '2', buyer: capturo('Beto') },
    ];
    const list = maximoGestionPorComprador(rows);
    expect(list.map((g) => g.comprador)).toEqual(['Ana']);
    expect(maximoGestion(rows).desde_aprobacion.total).toBe(2);
  });

  it('sortGestion: el umbral es min_oc (3) y el grupo sin comprador va al final aunque tenga más OC', () => {
    const g = (
      comprador: string | null,
      promedio_dias: number,
      total: number,
    ): GestionPorComprador => ({
      comprador,
      grupo: comprador === null ? 'sin_comprador' : 'persona',
      tipo: comprador === null ? null : 'capturo',
      documentos_capturo: comprador === null ? 0 : total,
      promedio_dias,
      mediana_dias: promedio_dias,
      total,
      descartadas: 0,
    });
    expect(MIN_OC_GESTION).toBe(3);
    expect(
      sortGestion([
        g(null, 1, 50),
        g('Dos', 1, 2),
        g('Tres lenta', 20, 3),
        g('Tres rápida', 5, 3),
        g('Una', 3, 1),
      ]).map((x) => x.comprador),
    ).toEqual(['Tres rápida', 'Tres lenta', 'Dos', 'Una', null]);
  });

  it('buildGestionPorComprador: el total es G2 del conjunto completo, con las definiciones del tablero', () => {
    const pos = [
      sapPo(1, '2026-03-11', capturo('Jorge')),
      sapPo(2, '2026-03-21', nadie),
    ];
    const maximo = [
      { dias: '7', dias_desde_aprobacion: '3', buyer: capturo('Víctor') },
    ];
    const block = buildGestionPorComprador({ pos, requests }, maximo);
    expect(block.min_oc).toBe(3);
    expect(block.sap.total).toEqual(sapGestionDays(pos, requests));
    expect(block.maximo.total).toEqual(maximoGestion(maximo).creacion);
    expect(block.maximo.total_desde_aprobacion).toEqual(
      maximoGestion(maximo).desde_aprobacion,
    );
    expect(block.sap.definicion).toContain('solicitud de pedido');
    expect(block.maximo.definicion).toContain('AB_CONTRATOS');
    expect(block.maximo.definicion_secundaria).toContain('aprobación');
    expect(block.sap.compradores.map((c) => c.comprador)).toEqual([
      'Jorge',
      null,
    ]);
  });
});

describe('N2: la persona ligada a su perfil', () => {
  const dir = buildPersonDirectory(
    [
      { code: 'IVTOG', profile_id: 'p-ingrid' },
      { code: 'SINPERFIL', profile_id: null },
    ],
    [
      { id: 'p-ingrid', full_name: 'Ingrid Torres Gutiérrez' },
      { id: 'p-ana-1', full_name: 'Ana Pérez' },
      { id: 'p-ana-2', full_name: 'ANA PEREZ' },
    ],
  );

  it('SAP por su nombre (plegado) y Maximo por el alias ligado: el mismo perfil y su nombre', () => {
    const sap = sapKpiBuyer('Ingrid Torres GUTIÉRREZ', dir);
    const maximo = maximoKpiBuyer(
      { rq_buyer: 'IVTOG' },
      new Map([['IVTOG', 'Ingrid']]),
      dir,
    );
    expect(sap).toMatchObject({ profileId: 'p-ingrid' });
    expect(maximo).toMatchObject({
      name: 'Ingrid',
      alias: true,
      profileId: 'p-ingrid',
      profileName: 'Ingrid Torres Gutiérrez',
    });
    const groups = groupByBuyer([sap, maximo], (b) => b);
    expect(groups.map((g) => [g.comprador, g.documentos])).toEqual([
      ['Ingrid Torres Gutiérrez', 2],
    ]);
  });

  it('el usuario de la integración de SAP nunca es comprador: sin comprador identificado', () => {
    expect(sapKpiBuyer('FAVOR DE NO TOCAR USUARIO PP XAMAI', dir)).toEqual({
      name: null,
      kind: null,
    });
    expect(sapKpiBuyer('Favor de no tocar usuario PP Xamai')).toEqual({
      name: null,
      kind: null,
    });
  });

  it('el alias ligado nombra igual que SAP pero el perfil tiene otro nombre: una sola persona (revisión N)', () => {
    const dir2 = buildPersonDirectory(
      [
        {
          code: 'IVTOG',
          display_name: 'Ingrid Torres Gutiérrez',
          profile_id: 'p-ingrid',
        },
      ],
      [{ id: 'p-ingrid', full_name: 'Ingrid Torres', is_active: true }],
    );
    const sap = sapKpiBuyer('Ingrid Torres GUTIÉRREZ', dir2);
    const maximo = maximoKpiBuyer(
      { rq_buyer: 'IVTOG' },
      new Map([['IVTOG', 'Ingrid Torres Gutiérrez']]),
      dir2,
    );
    expect(
      groupByBuyer([sap, maximo], (b) => b).map((g) => [
        g.comprador,
        g.documentos,
      ]),
    ).toEqual([['Ingrid Torres', 2]]);
  });

  it('perfil inactivo ligado por su alias: conserva su nombre; por nombre solo ligan los activos', () => {
    const dir2 = buildPersonDirectory(
      [{ code: 'JAGS1', display_name: 'Jorge', profile_id: 'p-jorge' }],
      [{ id: 'p-jorge', full_name: 'Jorge González', is_active: false }],
    );
    expect(
      maximoKpiBuyer({ rq_buyer: 'JAGS1' }, new Map(), dir2),
    ).toMatchObject({ profileId: 'p-jorge', profileName: 'Jorge González' });
    expect(sapKpiBuyer('Jorge González', dir2).profileId).toBeUndefined();
  });

  it('usuarios de sistema de Maximo (MAXADMIN, MAXREG): sin comprador', () => {
    expect(
      maximoKpiBuyer(
        { rq_buyer: 'maxadmin' },
        new Map([['maxadmin', 'MAXADMIN (usuario del sistema)']]),
      ),
    ).toEqual({ name: null, kind: null, alias: false });
    expect(
      maximoKpiBuyer({ purchase_agent: 'MAXREG' }, new Map()),
    ).toMatchObject({
      name: null,
    });
  });

  it('dos perfiles con el mismo nombre: no se adivina (queda por nombre)', () => {
    expect(sapKpiBuyer('Ana Pérez', dir).profileId).toBeUndefined();
  });
});

describe('N1: adjudicado y ahorro por persona', () => {
  it('junta adjudicado y ahorro de la misma persona; OC = las adjudicadas; orden por adjudicado en MXN; sin comprador al final', () => {
    const adj = (
      fuente: 'sap' | 'maximo',
      buyer: Buyer,
      currency: string,
      total: number,
      count: number,
      sin_subtotal = 0,
    ) => ({ fuente, buyer, currency, total, count, sin_subtotal });
    const list = compradoresAdjudicado(
      [
        adj('sap', capturo('Beto'), 'MXN', 100, 2),
        adj('maximo', capturo('Carla'), 'MXN', 900.5, 3, 1),
        adj('sap', nadie, 'MXN', 5000, 1),
        adj('maximo', capturo('BETO'), 'USD', 10, 1),
      ],
      [ahorro('maximo', capturo('Carla'), 'MXN', 45, 2)],
    );
    expect(list).toEqual([
      {
        comprador: 'Carla',
        grupo: 'persona',
        tipo: 'capturo',
        documentos: 3,
        documentos_capturo: 3,
        adjudicado: [
          { currency: 'MXN', total: 900.5, count: 3, sin_subtotal: 1 },
        ],
        ahorro: {
          documentos: 2,
          por_moneda: [{ currency: 'MXN', total: 45, count: 2 }],
        },
      },
      {
        comprador: 'Beto',
        grupo: 'persona',
        tipo: 'capturo',
        documentos: 3,
        documentos_capturo: 3,
        adjudicado: [
          { currency: 'MXN', total: 100, count: 2, sin_subtotal: 0 },
          { currency: 'USD', total: 10, count: 1, sin_subtotal: 0 },
        ],
        ahorro: { documentos: 0, por_moneda: [] },
      },
      {
        comprador: null,
        grupo: 'sin_comprador',
        tipo: null,
        documentos: 1,
        documentos_capturo: 0,
        adjudicado: [
          { currency: 'MXN', total: 5000, count: 1, sin_subtotal: 0 },
        ],
        ahorro: { documentos: 0, por_moneda: [] },
      },
    ]);
  });
});

describe('N2: gestiones de "Ambos" sistemas', () => {
  it('N = SAP + Maximo; promedio y mediana de los días de cada OC (no el promedio de las medianas)', () => {
    const sapPo = (doc: number, base: number, day: string, buyer: Buyer) => ({
      doc_entry: doc,
      doc_date: d(day),
      base_request_entries: [base],
      buyer,
    });
    const requests = [{ doc_entry: 1, doc_date: d('2026-03-01') }];
    const ana = capturo('Ana');
    const result = buildGestionAmbos(
      {
        // SAP: 1, 2 y 30 días (mediana 2)
        pos: [
          sapPo(10, 1, '2026-03-02', ana),
          sapPo(11, 1, '2026-03-03', ana),
          sapPo(12, 1, '2026-03-31', ana),
        ],
        requests,
      },
      // Maximo: 4 y 5 días (mediana 4.5)
      [
        { dias: '4', dias_desde_aprobacion: null, buyer: ana },
        { dias: '5', dias_desde_aprobacion: null, buyer: ana },
        { dias: null, dias_desde_aprobacion: null, buyer: capturo('Beto') },
      ],
    );
    // 1, 2, 4, 5, 30 → promedio 8.4 y mediana 4 (las medianas promediadas
    // darían 3.25)
    expect(result.total).toEqual({
      promedio_dias: 8.4,
      mediana_dias: 4,
      total: 5,
      sap: 3,
      maximo: 2,
    });
    // Beto no tiene OC en el promedio: no sale
    expect(result.compradores).toEqual([
      {
        comprador: 'Ana',
        grupo: 'persona',
        tipo: 'capturo',
        documentos_capturo: 5,
        promedio_dias: 8.4,
        mediana_dias: 4,
        total: 5,
        sap: 3,
        maximo: 2,
      },
    ]);
  });

  it('orden: por gestiones (N ≥ min_oc), empate el más rápido; luego los de menos OC; sin comprador al final', () => {
    const g = (comprador: string | null, total: number, promedio: number) => ({
      comprador,
      grupo:
        comprador === null ? ('sin_comprador' as const) : ('persona' as const),
      total,
      promedio_dias: promedio,
    });
    expect(
      sortGestion(
        [
          g(null, 50, 1),
          g('Lenta', 3, 40),
          g('Poca', 2, 1),
          g('Mucha', 9, 30),
          g('Rápida', 3, 5),
        ],
        3,
      ).map((x) => x.comprador),
    ).toEqual(['Mucha', 'Rápida', 'Lenta', 'Poca', null]);
  });
});

describe('O3: solo compradores, y las OC de contrato aparte', () => {
  const aliases = new Map([
    ['ADCS1', 'Ana Daniela Contreras Sánchez'],
    ['DYMP1', 'Diana Yohara Méndez'],
  ]);
  const mark = buildBuyerMark();

  it('Maximo: una OC de contrato va a su grupo aunque traiga RQ o agente de compras', () => {
    expect(
      maximoKpiBuyer(
        {
          de_contrato: true,
          rq_buyer: 'ADCS1',
          purchase_agent: 'DYMP1',
          created_by: 'ACXA1',
        },
        aliases,
      ),
    ).toBe(OC_DE_CONTRATO);
  });

  it('Maximo: el comprador de la RQ gana al agente de compras; su nombre es el del alias, si no el de la RQ, si no el usuario', () => {
    expect(
      maximoKpiBuyer(
        {
          rq_buyer: 'DYMP1',
          rq_buyer_name: 'Diana Yohara',
          purchase_agent: 'ADCS1',
          created_by: 'IVTOG',
        },
        aliases,
      ),
    ).toEqual({ name: 'Diana Yohara Méndez', kind: 'comprador', alias: true });
    expect(
      maximoKpiBuyer(
        { rq_buyer: 'JAGS1', rq_buyer_name: 'Jorge Alberto González Soriano' },
        aliases,
      ),
    ).toEqual({
      name: 'Jorge Alberto González Soriano',
      kind: 'comprador',
      alias: false,
    });
    expect(maximoKpiBuyer({ rq_buyer: 'NUEVO1' }, aliases)).toEqual({
      name: 'NUEVO1',
      kind: 'comprador',
      alias: false,
    });
    // sin RQ, el agente de compras (E4)
    expect(
      maximoKpiBuyer({ purchase_agent: 'ADCS1', created_by: 'IVTOG' }, aliases),
    ).toEqual({
      name: 'Ana Daniela Contreras Sánchez',
      kind: 'comprador',
      alias: true,
    });
  });

  it('SAP: quien capturó cuenta solo si está marcado; la marca se compara sin acentos ni mayúsculas', () => {
    expect(COMPRADORES_SAP.map((c) => c.maximo)).toEqual([
      'IVTOG',
      'DYMP1',
      'JAGS1',
      'ADCS1',
    ]);
    expect(sapKpiBuyer('Ingrid Torres GUTIÉRREZ', undefined, mark)).toEqual({
      name: 'Ingrid Torres GUTIÉRREZ',
      kind: 'capturo',
    });
    expect(sapKpiBuyer('Diana Yohara MÉNDEZ', undefined, mark).name).toBe(
      'Diana Yohara MÉNDEZ',
    );
    expect(sapKpiBuyer('Francisco López ORATO', undefined, mark)).toEqual({
      name: null,
      kind: null,
    });
    // sin marca, como en N
    expect(sapKpiBuyer('Francisco López ORATO').name).toBe(
      'Francisco López ORATO',
    );
  });

  it('la marca vale para la persona: SAP la escribe distinto pero liga al perfil de su usuario de Maximo', () => {
    const dir = buildPersonDirectory(
      [
        {
          code: 'ADCS1',
          display_name: 'Ana Daniela Contreras Sánchez',
          profile_id: 'p-ana',
        },
      ],
      [{ id: 'p-ana', full_name: 'Ana Contreras', is_active: true }],
    );
    const conPerfil = buildBuyerMark(dir);
    expect(conPerfil.profiles).toEqual(new Set(['p-ana']));
    const ana = sapKpiBuyer('ANA CONTRERAS', dir, conPerfil);
    expect(ana).toMatchObject({ name: 'ANA CONTRERAS', profileId: 'p-ana' });
    expect(isMarkedBuyer(ana, conPerfil)).toBe(true);
    expect(
      isMarkedBuyer({ name: 'Otra Persona', kind: 'capturo' }, conPerfil),
    ).toBe(false);
  });

  it('terminado cuando: la OC de contrato va a su grupo y la OC sin contrato que capturó quien no es comprador va a "Sin comprador identificado"; las sumas cuadran', () => {
    const adj = (
      fuente: AdjudicadoEntry['fuente'],
      buyer: KpiBuyer,
      currency: string,
      total: number,
      count = 1,
    ): AdjudicadoEntry => ({
      fuente,
      buyer,
      currency,
      total,
      count,
      sin_subtotal: 0,
    });
    const deMaximo = (fields: Parameters<typeof maximoKpiBuyer>[0]) =>
      maximoKpiBuyer(fields, aliases);
    const adjudicado = [
      // de contrato, la capturó quien no es comprador (Acxa)
      adj(
        'maximo',
        deMaximo({ de_contrato: true, created_by: 'ACXA1' }),
        'MXN',
        50000,
      ),
      // sin contrato ni RQ, la capturó Ingrid: ya no es su barra
      adj('maximo', deMaximo({ created_by: 'IVTOG' }), 'MXN', 700),
      adj('maximo', deMaximo({ rq_buyer: 'ADCS1' }), 'MXN', 1000, 2),
      adj('maximo', deMaximo({ rq_buyer: 'ADCS1' }), 'USD', 100),
      // SAP: Ingrid marcada; Francisco López no
      adj(
        'sap',
        sapKpiBuyer('Ingrid Torres GUTIÉRREZ', undefined, mark),
        'MXN',
        300,
      ),
      adj(
        'sap',
        sapKpiBuyer('Francisco López ORATO', undefined, mark),
        'MXN',
        90,
      ),
    ];
    const ahorros = [
      ahorro('maximo', deMaximo({ rq_buyer: 'ADCS1' }), 'MXN', 40),
      ahorro('maximo', deMaximo({ de_contrato: true }), 'MXN', 25),
      ahorro(
        'sap',
        sapKpiBuyer('Francisco López ORATO', undefined, mark),
        'MXN',
        5,
      ),
    ];
    const list = compradoresAdjudicado(adjudicado, ahorros);
    expect(
      list.map((c) => [c.comprador, c.grupo, c.tipo, c.documentos]),
    ).toEqual([
      ['Ana Daniela Contreras Sánchez', 'persona', 'comprador', 3],
      ['Ingrid Torres GUTIÉRREZ', 'persona', 'capturo', 1],
      // gris y al final: primero sin comprador, luego las de contrato
      [null, 'sin_comprador', null, 2],
      [null, 'contrato', null, 1],
    ]);
    expect(list[2].adjudicado).toEqual([
      { currency: 'MXN', total: 790, count: 2, sin_subtotal: 0 },
    ]);
    expect(list[3].adjudicado[0].total).toBe(50000);
    // personas + "Sin comprador" + "OC de contrato" = Órdenes sin IVA del tablero
    const total = buildAdjudicado(adjudicado);
    for (const card of total.por_moneda) {
      const bars = list.flatMap((c) =>
        c.adjudicado.filter((m) => m.currency === card.currency),
      );
      expect(
        Math.round(bars.reduce((s, m) => s + m.total, 0) * 100) / 100,
      ).toBe(card.total);
      expect(bars.reduce((s, m) => s + m.count, 0)).toBe(card.count);
    }
    // y el ahorro = la tarjeta
    const card = buildAhorro(ahorros);
    expect(
      list.reduce(
        (s, c) =>
          s +
          (c.ahorro.por_moneda.find((m) => m.currency === 'MXN')?.total ?? 0),
        0,
      ),
    ).toBe(card.por_moneda[0].total);
    expect(card.por_comprador.map((b) => b.grupo)).toEqual([
      'persona',
      'sin_comprador',
      'contrato',
    ]);
  });

  it('gestiones: el grupo de contrato va después de "Sin comprador identificado", sin tipo', () => {
    const result = buildGestionAmbos({ pos: [], requests: [] }, [
      { dias: '30', dias_desde_aprobacion: null, buyer: OC_DE_CONTRATO },
      { dias: '9', dias_desde_aprobacion: null, buyer: OC_DE_CONTRATO },
      {
        dias: '4',
        dias_desde_aprobacion: null,
        buyer: { name: null, kind: null },
      },
      { dias: '2', dias_desde_aprobacion: null, buyer: comprador('Ana') },
    ]);
    expect(
      result.compradores.map((c) => [c.comprador, c.grupo, c.tipo, c.total]),
    ).toEqual([
      ['Ana', 'persona', 'comprador', 1],
      [null, 'sin_comprador', null, 1],
      [null, 'contrato', null, 2],
    ]);
    expect(result.total.total).toBe(4);
  });

  it('aviso antes de 2026: con "Todos" o un año anterior, sí; desde 2026, no; explica Maximo y SAP', () => {
    expect(compradorAviso(2026)).toBeNull();
    expect(compradorAviso(2027)).toBeNull();
    expect(compradorAviso(null)).toBe(
      'El comprador se registra desde 2026. En Maximo sale de la solicitud de cotización (RQ), que las OC de antes casi no traen; en SAP solo cuentan quienes hoy son compradores (Ingrid, Diana, Jorge y Ana). Por eso, con "Todos", muchas OC van a "Sin comprador identificado".',
    );
    expect(compradorAviso(2025)).toContain('Por eso, en 2025, muchas OC');
  });

  it('una RQ movida por un usuario de sistema no tiene comprador: sigue el agente de compras', () => {
    expect(
      maximoKpiBuyer(
        { rq_buyer: 'MAXADMIN', purchase_agent: 'ADCS1' },
        aliases,
      ),
    ).toEqual({
      name: 'Ana Daniela Contreras Sánchez',
      kind: 'comprador',
      alias: true,
    });
    expect(maximoKpiBuyer({ rq_buyer: 'maxreg' }, aliases)).toEqual({
      name: null,
      kind: null,
      alias: false,
    });
  });
});
