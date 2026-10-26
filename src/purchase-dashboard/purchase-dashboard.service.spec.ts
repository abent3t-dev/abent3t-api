/**
 * Sprint 2026-09-22 (A1) — resumen del dashboard con las tres fuentes.
 * Prisma mockeado: se pinza (1) que los montos se agregan POR MONEDA sin
 * mezclar monedas, (2) que los días de gestión salen null cuando no hay
 * base (nunca 0) y (3) que los totales suman las tres fuentes.
 *
 * Bloque 2026-09-23: (4) D1 — el total combinado de órdenes descuenta las
 * OC de SAP migradas que existen en Maximo (la consulta de SAP ya viene
 * filtrada; aquí se pinza que el desglose `migradas` viaja y que el total
 * = SAP contadas una vez + Maximo + ABENT); (5) D3 — días de gestión SAP OC
 * = OC − solicitud base, con N visible.
 *
 * 2026-09-28: (6) G2 — una definición de gestión por sistema (SAP D3 y
 * Maximo OC − PR.ISSUEDATE) con mediana; (7) G3 — pendientes = RQ sin OC.
 *
 * K4 (2026-10-05): sin folio. Maximo: solicitudes por PR y por ISSUEDATE
 * con "N llegaron a Compras"; pendientes = APPR sin OC ni contrato (WAPPR
 * aparte); G2 con la fecha de la PR de AB_CONTRATOS como respaldo y el dato
 * desde la aprobación.
 *
 * K6 (2026-10-05): Órdenes en la base de TABLERO_MONTO_BASE con el
 * subtotal sin IVA y las OC sin él por moneda (mergeAmounts los suma; las
 * propias de ABENT van a sin_subtotal); "por recibir" sin cambio;
 * CAPEX/OPEX suma el subtotal de Maximo (antes TOTALCOST, con IVA).
 *
 * Bloque M (2026-10-14): M1 ahorro y M2 días de gestión por comprador en
 * Órdenes, con OC sintéticas de SAP y Maximo (un "Postgres de juguete" que
 * agrupa como las consultas y aplica D1 y el año solo si el SQL los trae).
 *
 * Bloque N (2026-10-16): N1 monto adjudicado sin IVA por persona (= la
 * tarjeta de Órdenes del tablero), N2 "Ambos" y la persona ligada a su
 * perfil, N3 desde cuándo hay ahorro capturado.
 */
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { TABLERO_MONTO_BASE } from '../common/sql/erp-views.sql';
import {
  abentAmounts,
  mergeAmounts,
  PurchaseDashboardService,
} from './purchase-dashboard.service';

// El objeto real de exports (no el namespace de `import *`, que solo tiene
// getters): permite cambiar TABLERO_MONTO_BASE en una prueba
const erpViews = jest.requireActual<{ TABLERO_MONTO_BASE: string }>(
  '../common/sql/erp-views.sql',
);

function makeService(sapEnabled: boolean | string = true) {
  const queryRaw = jest.fn();
  // N2: perfiles activos para ligar a cada persona (ninguno por defecto)
  const profilesFindMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    $queryRaw: queryRaw,
    profiles: { findMany: profilesFindMany },
  } as unknown as PrismaService;
  const config = {
    get: (key: string) =>
      key === 'SAP_SYNC_ENABLED'
        ? sapEnabled
        : key === 'MAXIMO_SYNC_ENABLED'
          ? false
          : undefined,
  } as unknown as ConfigService;
  // M1/M2: alias de Compras de los códigos de Maximo (sin alias por defecto)
  const resolveMany = jest.fn().mockResolvedValue(new Map<string, string>());
  // N2: alias con su perfil ligado (ninguno por defecto)
  const byCode = jest
    .fn()
    .mockResolvedValue(
      new Map<
        string,
        { code: string; display_name: string; profile_id: string | null }
      >(),
    );
  const aliases = { resolveMany, byCode } as unknown as ErpAliasesService;
  return {
    service: new PurchaseDashboardService(prisma, config, aliases),
    queryRaw,
    resolveMany,
    byCode,
    profilesFindMany,
  };
}

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('PurchaseDashboardService.getSummary', () => {
  it('agrega SAP + Maximo + ABENT, montos por moneda, migradas descontadas y días D3', async () => {
    const { service, queryRaw } = makeService();
    queryRaw
      // G3: SAP sin OC (12 meses / sin límite)
      .mockResolvedValueOnce([{ pendientes: 5, sin_limite: 9 }])
      // K4: Maximo APPR sin OC ni contrato (12 meses / sin límite); I8: de
      // contrato; con OC (dato) y WAPPR aparte
      .mockResolvedValueOnce([
        {
          pendientes: 2,
          sin_limite: 40,
          de_contrato: 3,
          de_contrato_sin_limite: 4,
          aprobadas_con_oc: 1,
          aprobadas_con_oc_sin_limite: 1,
          en_aprobacion: 7,
          en_aprobacion_sin_limite: 26,
          con_estatus: 5197,
        },
      ])
      // sapPr total
      .mockResolvedValueOnce([{ total: 309 }])
      // sapPo por moneda (la consulta ya excluye las migradas que existen en
      // Maximo); K6: con el subtotal sin IVA y las OC sin él
      .mockResolvedValueOnce([
        {
          currency: 'MXN',
          total: '1000.50',
          subtotal: '862.50',
          sin_subtotal: 0,
          count: 3000,
        },
        {
          currency: 'USD',
          total: '20',
          subtotal: 0,
          sin_subtotal: 5,
          count: 5,
        },
      ])
      // sapPoOpen
      .mockResolvedValueOnce([{ currency: 'MXN', total: '100', count: 750 }])
      // K4.3: maximoPr = PR distintas por ISSUEDATE; llegaron a Compras
      .mockResolvedValueOnce([{ total: 6, llegaron: 4 }])
      // G2: días de gestión Maximo (OC − creación de su PR); null = OC sin PR.
      // K4.3: y desde la aprobación (primer APPR)
      .mockResolvedValueOnce([
        { dias: '19', dias_desde_aprobacion: '15' },
        { dias: '21', dias_desde_aprobacion: null },
        { dias: null, dias_desde_aprobacion: null },
        { dias: '-2', dias_desde_aprobacion: '-3' },
      ])
      // maximoPo (K6: 2 de las 7 sin subtotal)
      .mockResolvedValueOnce([
        {
          currency: 'MXN',
          total: '50',
          subtotal: '30',
          sin_subtotal: 2,
          count: 7,
        },
      ])
      // maximoPoOpen
      .mockResolvedValueOnce([{ currency: 'MXN', total: '10', count: 2 }])
      // abentRq
      .mockResolvedValueOnce([{ total: 0, pendientes: 0 }])
      // abentRqDias
      .mockResolvedValueOnce([{ dias: null }])
      // abentPo
      .mockResolvedValueOnce([{ currency: 'MXN', total: 0, count: 0 }])
      // abentPoOpen
      .mockResolvedValueOnce([{ currency: 'MXN', total: 0, count: 0 }])
      // migradas (D1): 1,597 con PONUM, 1,500 existen en Maximo
      .mockResolvedValueOnce([{ total: 1597, en_maximo: 1500 }])
      // gestionPos (D3): dos OC con solicitud base
      .mockResolvedValueOnce([
        {
          doc_entry: 1,
          doc_date: d('2026-09-11'),
          base_request_entries: [100],
        },
        {
          doc_entry: 2,
          doc_date: d('2026-09-21'),
          base_request_entries: [101],
        },
      ])
      // range (D4)
      .mockResolvedValueOnce([
        {
          sap_desde: d('2023-12-31'),
          maximo_desde: d('2019-07-01'),
          sap_sync: d('2026-09-23'),
          maximo_sync: null,
        },
      ])
      // years
      .mockResolvedValueOnce([{ year: 2026 }, { year: 2025 }])
      // gestionPrs (segunda vuelta, D3)
      .mockResolvedValueOnce([
        { doc_entry: 100, doc_date: d('2026-09-01') },
        { doc_entry: 101, doc_date: d('2026-09-01') },
      ]);

    const summary = await service.getSummary();

    expect(summary.solicitudes).toEqual({
      total: 315,
      pendientes: 7,
      por_fuente: {
        sap: { total: 309, pendientes: 5, pendientes_sin_limite: 9 },
        maximo: {
          total: 6,
          llegaron_a_compras: 4,
          pendientes: 2,
          pendientes_sin_limite: 40,
          de_contrato: 3,
          de_contrato_sin_limite: 4,
          aprobadas_con_oc: 1,
          aprobadas_con_oc_sin_limite: 1,
          en_aprobacion: 7,
          en_aprobacion_sin_limite: 26,
        },
        abent: { total: 0, pendientes: 0 },
      },
      pendientes_periodo: {
        desde: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown,
        hasta: null,
      },
    });
    // Misma moneda se suma entre fuentes; USD queda aparte; ABENT vacío no
    // aparece. K6: el subtotal y las OC sin él también se suman por moneda
    expect(summary.ordenes.total).toBe(3012);
    expect(summary.ordenes.monto_por_moneda).toEqual([
      {
        currency: 'MXN',
        total: 1050.5,
        count: 3007,
        subtotal: 892.5,
        sin_subtotal: 2,
      },
      { currency: 'USD', total: 20, count: 5, subtotal: 0, sin_subtotal: 5 },
    ]);
    expect(summary.ordenes.monto_base).toBe(TABLERO_MONTO_BASE);
    // D1: desglose de migradas visible (descontadas = las que existen en Maximo)
    expect(summary.ordenes.migradas).toEqual({ total: 1597, en_maximo: 1500 });
    // K6: "por recibir" sin cambio (con IVA, sin subtotal)
    expect(summary.por_recibir.total).toBe(752);
    expect(summary.por_recibir.monto_por_moneda).toEqual([
      { currency: 'MXN', total: 110, count: 752 },
    ]);
    expect(summary.por_recibir.monto_base).toBe('con_iva');
    // G2: una definición por sistema (RQ → OC) con promedio, mediana y N.
    // D3: SAP OC = (10 + 20) / 2 = 15 días, N = 2
    expect(summary.dias_gestion.sap).toMatchObject({
      promedio_dias: 15,
      mediana_dias: 15,
      total: 2,
      descartadas: 0,
    });
    // Maximo: (19 + 21) / 2 = 20; una OC sin PR y una negativa, fuera
    expect(summary.dias_gestion.maximo).toMatchObject({
      promedio_dias: 20,
      mediana_dias: 20,
      total: 2,
      descartadas: 1,
      sin_solicitud: 1,
    });
    // K4.3: el respaldo de la fecha de la PR va en la definición
    expect(summary.dias_gestion.maximo.definicion).toContain('AB_CONTRATOS');
    // K4.3: dato secundario desde la aprobación (15 días; sin APPR, fuera)
    expect(summary.dias_gestion.maximo_desde_aprobacion).toMatchObject({
      promedio_dias: 15,
      mediana_dias: 15,
      total: 1,
      descartadas: 1,
      sin_solicitud: 2,
    });
    expect(summary.dias_gestion.abent).toBeNull();
    // Ya no salen "SAP solicitudes" ni el tiempo de aprobación de las OC de
    // Maximo; K4.3 agrega el dato desde la aprobación de la PR
    expect(Object.keys(summary.dias_gestion).sort()).toEqual([
      'abent',
      'maximo',
      'maximo_desde_aprobacion',
      'sap',
    ]);
    expect(summary.datos.sap_desde).toBe('2023-12-31T00:00:00.000Z');
    expect(summary.datos.anios).toEqual([2026, 2025]);
    expect(summary.datos.ultima_sync.maximo).toBeNull();
    expect(summary.fuentes).toEqual({
      sap_sync_enabled: true,
      maximo_sync_enabled: false,
    });
    // K4: sin la ventana de folios (antes 19)
    expect(queryRaw).toHaveBeenCalledTimes(18);
  });

  it('D1: la consulta de OC de SAP descuenta las migradas que existen en Maximo', async () => {
    const { service, queryRaw } = makeService();
    queryRaw.mockResolvedValue([]);
    await service.getSummary(2025);
    const calls = queryRaw.mock.calls as unknown as Array<
      [{ sql: string; values: unknown[] }]
    >;
    const sqlTexts = calls.map(([q]) => q.sql.replace(/\s+/g, ' '));
    // K6: el monto de Órdenes ya no es `sum(doc_total)` fijo (va en la base
    // del tablero): se ubican por moneda (Órdenes y por recibir)
    const sapPoQueries = sqlTexts.filter(
      (t) =>
        t.includes('FROM sap_purchase_orders') &&
        t.includes('GROUP BY currency'),
    );
    expect(sapPoQueries.length).toBe(2);
    for (const q of sapPoQueries) {
      expect(q).toContain('maximo_ponum IS NOT NULL AND EXISTS');
      expect(q).toContain('doc_date >=');
    }
  });

  it('K6: Órdenes en la base del tablero con subtotal y OC sin él; por recibir sin cambio; ABENT a sin_subtotal', async () => {
    const { service, queryRaw } = makeService();
    // abentPo: 2 OC propias, base desconocida; lo demás vacío
    queryRaw.mockImplementation((q: { sql: string }) =>
      Promise.resolve(
        q.sql.includes(
          'FROM purchase_orders WHERE is_active = true AND status <>',
        )
          ? [{ currency: 'MXN', total: '300', count: 2 }]
          : [],
      ),
    );
    const summary = await service.getSummary(2026);
    expect(summary.ordenes.por_fuente.abent.monto_por_moneda).toEqual([
      { currency: 'MXN', total: 300, count: 2, subtotal: 0, sin_subtotal: 2 },
    ]);
    expect(summary.ordenes.monto_por_moneda).toEqual([
      { currency: 'MXN', total: 300, count: 2, subtotal: 0, sin_subtotal: 2 },
    ]);
    expect(summary.ordenes.monto_nota).toContain('IVA');

    const texts = (
      queryRaw.mock.calls as unknown as Array<[{ sql: string }]>
    ).map(([q]) => q.sql.replace(/\s+/g, ' '));
    const sapMonto =
      TABLERO_MONTO_BASE === 'sin_iva'
        ? 'sum(sap_purchase_orders.subtotal), 0) AS total'
        : 'sum(sap_purchase_orders.doc_total), 0) AS total';
    const maximoMonto =
      TABLERO_MONTO_BASE === 'sin_iva'
        ? 'sum(c.subtotal), 0) AS total'
        : 'sum(c.total_cost), 0) AS total';
    const sapOrdenes = texts.filter((t) => t.includes(sapMonto));
    expect(sapOrdenes).toHaveLength(1);
    expect(sapOrdenes[0]).toContain(
      'count(*) FILTER (WHERE sap_purchase_orders.subtotal IS NULL)::int AS sin_subtotal',
    );
    const maximoOrdenes = texts.filter((t) => t.includes(maximoMonto));
    expect(maximoOrdenes).toHaveLength(1);
    expect(maximoOrdenes[0]).toContain(
      'coalesce(sum(c.subtotal), 0) AS subtotal',
    );
    // por recibir: las mismas consultas de antes, con IVA y sin subtotal
    const abiertas = texts.filter(
      (t) =>
        t.includes('GROUP BY currency') &&
        (t.includes("document_status = 'bost_Open'") ||
          t.includes("status IN ('APPR', 'INPRG')")),
    );
    expect(abiertas).toHaveLength(2);
    for (const t of abiertas) {
      expect(t).toMatch(/sum\((doc_total|total_cost)\)/);
      expect(t).not.toContain('subtotal');
    }
  });

  it('K4.3: el selector de años toma las PR de Maximo por pr_issue_date de la vista por PR (sin obsoletas)', async () => {
    const { service, queryRaw } = makeService();
    queryRaw.mockResolvedValue([]);
    await service.getSummary();
    const calls = queryRaw.mock.calls as unknown as Array<
      [{ strings?: string[] } | string]
    >;
    const sqlTexts = calls.map(([first]) =>
      typeof first === 'string' ? first : (first.strings?.join('?') ?? ''),
    );
    const yearQueries = sqlTexts.filter((t) =>
      t.includes('extract(year FROM d)'),
    );
    expect(yearQueries).toHaveLength(1);
    const [years] = yearQueries;
    expect(years).toContain('SELECT pr_issue_date FROM');
    expect(years).toContain('superseded_at IS NULL');
    expect(years).toContain('DISTINCT ON (prnum)');
    expect(years).not.toContain('created_at_source FROM maximo_contracts');
  });

  it('K4.3: solicitudes de Maximo = PR distintas por ISSUEDATE (vista por PR); G2 con la fecha de la PR de respaldo; sin folio', async () => {
    const { service, queryRaw } = makeService();
    queryRaw.mockResolvedValue([]);
    await service.getSummary(2026);
    const calls = queryRaw.mock.calls as unknown as Array<
      [{ sql: string; values: unknown[] }]
    >;
    const queries = calls.map(([q]) => ({
      text: q.sql.replace(/\s+/g, ' '),
      values: q.values,
    }));
    const yearFrom = new Date(Date.UTC(2026, 0, 1));
    // ya no hay ventana de folios en ninguna consulta
    expect(queries.some((q) => q.text.includes('regexp_replace'))).toBe(false);

    const prs = queries.filter((q) => q.text.includes('AS llegaron'));
    expect(prs).toHaveLength(1);
    expect(prs[0].text).toContain('count(DISTINCT p.prnum)::int AS total');
    expect(prs[0].text).toContain('DISTINCT ON (prnum)');
    expect(prs[0].text).toContain('superseded_at IS NULL');
    expect(prs[0].text).toContain(
      'AND p.pr_issue_date >= ? AND p.pr_issue_date < ?',
    );
    expect(prs[0].text).toContain('p.pr_approved_at IS NOT NULL');
    expect(prs[0].values).toContainEqual(yearFrom);

    const gestion = queries.filter((q) =>
      q.text.includes('dias_desde_aprobacion'),
    );
    expect(gestion).toHaveLength(1);
    expect(gestion[0].text).toContain('coalesce(oc.pr_issue_date, f.emision)');
    expect(gestion[0].text).toContain('unnest(oc.pr_nums)');
    expect(gestion[0].text).toContain('v.created_at_source >= ?');
    expect(gestion[0].values).toContainEqual(yearFrom);
  });

  it('acepta la bandera de sync como string (sin Joi en tests)', async () => {
    const { service, queryRaw } = makeService('true');
    queryRaw.mockResolvedValue([]);
    const summary = await service.getSummary();
    expect(summary.fuentes.sap_sync_enabled).toBe(true);
    expect(summary.solicitudes.total).toBe(0);
    expect(summary.ordenes.monto_por_moneda).toEqual([]);
    expect(summary.dias_gestion.sap.promedio_dias).toBeNull();
    // sin estatus de PR (antes del primer full), los pendientes de Maximo
    // no se inventan (K4: tampoco las que llegaron ni las en aprobación)
    expect(summary.solicitudes.por_fuente.maximo).toMatchObject({
      pendientes: null,
      llegaron_a_compras: null,
      en_aprobacion: null,
      de_contrato: null,
      // H8: tampoco los sin límite (el tooltip decía "Maximo 0")
      pendientes_sin_limite: null,
      de_contrato_sin_limite: null,
      aprobadas_con_oc_sin_limite: null,
      en_aprobacion_sin_limite: null,
      // sin año cuenta todas las PR: es dato aunque no haya estatus
      total: 0,
    });
  });

  it('H8: con año y sin ninguna PR con estatus, "Solicitudes totales" de Maximo = null (no 0); con base, 0 es 0', async () => {
    const { service, queryRaw } = makeService();
    queryRaw.mockResolvedValue([]);
    const sinBase = await service.getSummary(2026);
    expect(sinBase.solicitudes.por_fuente.maximo.total).toBeNull();
    expect(sinBase.solicitudes.total).toBe(0);

    // con base (alguna PR con estatus): un año sin PR es 0, no null
    queryRaw.mockImplementation((q: { sql: string }) =>
      Promise.resolve(
        q.sql.includes('AS con_estatus')
          ? [
              {
                pendientes: 0,
                sin_limite: 0,
                de_contrato: 0,
                de_contrato_sin_limite: 0,
                aprobadas_con_oc: 0,
                aprobadas_con_oc_sin_limite: 0,
                en_aprobacion: 0,
                en_aprobacion_sin_limite: 0,
                con_estatus: 7,
              },
            ]
          : [],
      ),
    );
    const conBase = await service.getSummary(2026);
    expect(conBase.solicitudes.por_fuente.maximo).toMatchObject({
      total: 0,
      pendientes: 0,
      pendientes_sin_limite: 0,
      en_aprobacion_sin_limite: 0,
    });
  });

  it("H10: con TABLERO_MONTO_BASE='sin_iva' las OC propias no suman al total (solo en documentos y sin subtotal)", async () => {
    jest.replaceProperty(erpViews, 'TABLERO_MONTO_BASE', 'sin_iva');
    try {
      const { service, queryRaw } = makeService();
      queryRaw.mockImplementation((q: { sql: string }) =>
        Promise.resolve(
          q.sql.includes(
            'FROM purchase_orders WHERE is_active = true AND status <>',
          )
            ? [{ currency: 'MXN', total: '300', count: 2 }]
            : [],
        ),
      );
      const summary = await service.getSummary(2026);
      expect(summary.ordenes.monto_base).toBe('sin_iva');
      expect(summary.ordenes.por_fuente.abent.monto_por_moneda).toEqual([
        { currency: 'MXN', total: 0, count: 2, subtotal: 0, sin_subtotal: 2 },
      ]);
      expect(summary.ordenes.total).toBe(2);
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('PurchaseDashboardService.getOrdersKpis (D5)', () => {
  it('sin captura de ahorro → disponible=false y sin montos inventados', async () => {
    const { service, queryRaw } = makeService();
    queryRaw
      // M2: las OC de G2 (SAP y Maximo) van al final; aquí sin OC
      .mockResolvedValue([])
      .mockResolvedValueOnce([]) // sap ahorro
      .mockResolvedValueOnce([]) // maximo ahorro
      .mockResolvedValueOnce([
        { clas: 'OPEX', currency: 'MXN', docs: 40, total: '1234.5' },
        { clas: 'CAPEX', currency: 'USD', docs: 1, total: '99' },
      ])
      .mockResolvedValueOnce([
        // K6: subtotal sin IVA; 1 de las 3 sin subtotal (no suma)
        {
          clas: 'OPEX',
          currency: 'MXN',
          docs: 3,
          total: '100',
          sin_subtotal: 1,
        },
      ]);
    const kpis = await service.getOrdersKpis(null);
    expect(kpis.ahorro.disponible).toBe(false);
    expect(kpis.ahorro.por_moneda).toEqual([]);
    // M1: sin captura tampoco hay barras (el front pinta "No disponible")
    expect(kpis.ahorro.por_comprador).toEqual([]);
    expect(kpis.ahorro.documentos).toBe(0);
    expect(kpis.clasificacion.disponible).toBe(true);
    expect(kpis.clasificacion.opex.documentos).toBe(43);
    // H7: por moneda, cuántas no traen subtotal y si el monto tiene base
    expect(kpis.clasificacion.opex.por_moneda).toEqual([
      {
        currency: 'MXN',
        total: 1334.5,
        count: 43,
        sin_subtotal: 1,
        monto_disponible: true,
      },
    ]);
    expect(kpis.clasificacion.capex.por_fuente.sap.por_moneda).toEqual([
      { currency: 'USD', total: 99, count: 1 },
    ]);
    // K6: las OC sin subtotal se cuentan aparte y la nota lo dice
    expect(kpis.clasificacion.opex.sin_subtotal).toBe(1);
    expect(kpis.clasificacion.opex.por_fuente.maximo.sin_subtotal).toBe(1);
    expect(kpis.clasificacion.capex.sin_subtotal).toBe(0);
    expect(kpis.clasificacion.nota).toContain(
      '1 OC clasificada no tiene subtotal',
    );
    expect(kpis.clasificacion.nota).toContain('sin IVA');
  });

  it('K6: CAPEX/OPEX de Maximo suma el subtotal (no TOTALCOST): misma base que SAP; sin el aviso viejo de la OS', async () => {
    const { service, queryRaw } = makeService();
    queryRaw.mockResolvedValue([]);
    const kpis = await service.getOrdersKpis(2026);
    const texts = (
      queryRaw.mock.calls as unknown as Array<[{ sql: string }]>
    ).map(([q]) => q.sql.replace(/\s+/g, ' '));
    const maximoClas = texts.find((t) => t.includes('upper(ab_clasfpo)'));
    // H7: sin coalesce: ninguna OC con subtotal = sin monto (no 0)
    expect(maximoClas).toContain('sum(current.subtotal) AS total');
    expect(maximoClas).not.toContain('coalesce(sum(current.subtotal), 0)');
    expect(maximoClas).toContain(
      'count(*) FILTER (WHERE subtotal IS NULL)::int AS sin_subtotal',
    );
    expect(maximoClas).not.toContain('total_cost');
    // SAP: importe de la línea (sin IVA), como antes
    const sapClas = texts.find((t) => t.includes("line->>'U_Clas_gts'"));
    expect(sapClas).toContain("line->>'LineTotal'");
    expect(sapClas).not.toContain('doc_total');
    // las notas ya no traen el aviso viejo de que la Object Structure no trae el campo
    expect(kpis.ahorro.nota).not.toMatch(/(aún )?no (lo )?expone/);
    expect(kpis.clasificacion.nota).not.toContain('pendiente CIISA');
    expect(kpis.clasificacion.nota).toContain(
      '0 OC clasificadas no tienen subtotal',
    );
  });
});

describe('CAPEX/OPEX sin subtotal (H7)', () => {
  it('una moneda solo de Maximo y todas sin subtotal → monto_disponible=false (no "$0.00"); mezclada con SAP sí hay monto', async () => {
    const { service, queryRaw } = makeService();
    queryRaw
      // M2: las OC de G2 (SAP y Maximo) van al final; aquí sin OC
      .mockResolvedValue([])
      .mockResolvedValueOnce([]) // sap ahorro
      .mockResolvedValueOnce([]) // maximo ahorro
      // SAP: CAPEX en USD
      .mockResolvedValueOnce([
        { clas: 'CAPEX', currency: 'USD', docs: 1, total: '100' },
      ])
      // Maximo: CAPEX EUR (2, ninguna con subtotal) y USD (1 sin subtotal)
      .mockResolvedValueOnce([
        {
          clas: 'CAPEX',
          currency: 'EUR',
          docs: 2,
          total: null,
          sin_subtotal: 2,
        },
        {
          clas: 'CAPEX',
          currency: 'USD',
          docs: 1,
          total: null,
          sin_subtotal: 1,
        },
      ]);
    const kpis = await service.getOrdersKpis(2026);
    const capex = kpis.clasificacion.capex;
    expect(capex.por_moneda).toEqual([
      {
        currency: 'USD',
        total: 100,
        count: 2,
        sin_subtotal: 1,
        monto_disponible: true,
      },
      {
        currency: 'EUR',
        total: 0,
        count: 2,
        sin_subtotal: 2,
        monto_disponible: false,
      },
    ]);
    expect(capex.sin_subtotal).toBe(3);
    expect(capex.por_fuente.maximo.por_moneda).toContainEqual({
      currency: 'EUR',
      total: 0,
      count: 2,
      sin_subtotal: 2,
      monto_disponible: false,
    });
    expect(capex.documentos).toBe(4);
  });
});

describe('OC propias de ABENT en la base del tablero (H10)', () => {
  const rows = [{ currency: 'MXN', total: '300', count: 2 }];

  it('con IVA su monto entra al total; sin IVA no (como una OC sin subtotal); nunca al subtotal', () => {
    expect(abentAmounts(rows, 'con_iva')).toEqual([
      { currency: 'MXN', total: 300, count: 2, subtotal: 0, sin_subtotal: 2 },
    ]);
    expect(abentAmounts(rows, 'sin_iva')).toEqual([
      { currency: 'MXN', total: 0, count: 2, subtotal: 0, sin_subtotal: 2 },
    ]);
  });

  it('sin IVA: el total de la moneda trae solo el subtotal de Maximo, no el amount propio', () => {
    // Maximo en la base sin IVA: total = suma del subtotal
    const maximo = [
      { currency: 'MXN', total: 100, count: 3, subtotal: 100, sin_subtotal: 1 },
    ];
    expect(mergeAmounts([maximo, abentAmounts(rows, 'sin_iva')])).toEqual([
      { currency: 'MXN', total: 100, count: 5, subtotal: 100, sin_subtotal: 3 },
    ]);
  });
});

describe('mergeAmounts (K6)', () => {
  it('suma por moneda el total, el subtotal y las OC sin subtotal; monedas distintas aparte', () => {
    const sap = [
      { currency: 'MXN', total: 116, count: 2, subtotal: 100, sin_subtotal: 0 },
      { currency: 'USD', total: 58, count: 1, subtotal: 50, sin_subtotal: 0 },
    ];
    const maximo = [
      { currency: 'MXN', total: 232, count: 3, subtotal: 100, sin_subtotal: 1 },
    ];
    // ABENT: base desconocida, todas a sin_subtotal
    const abent = [
      { currency: 'MXN', total: 10, count: 2, subtotal: 0, sin_subtotal: 2 },
    ];
    expect(mergeAmounts([sap, maximo, abent])).toEqual([
      { currency: 'MXN', total: 358, count: 7, subtotal: 200, sin_subtotal: 3 },
      { currency: 'USD', total: 58, count: 1, subtotal: 50, sin_subtotal: 0 },
    ]);
  });

  it('sin subtotal en las filas (por recibir, ahorro) no inventa los campos', () => {
    expect(
      mergeAmounts([
        [{ currency: 'MXN', total: 1, count: 1 }],
        [{ currency: 'MXN', total: 2, count: 1 }],
      ]),
    ).toEqual([{ currency: 'MXN', total: 3, count: 2 }]);
  });
});

// ── Bloque M (2026-10-14): ahorro y tiempo de gestión por comprador ──────

type FakeQuery = { sql: string; values: unknown[] };

/** Alias de Compras (Roles → "Usuarios de SAP y Maximo"). */
const ALIASES = new Map([
  ['VMM3', 'Víctor Martínez'],
  ['AMONDRAG', 'Ana Aurora Mondragón'],
  ['JAGS1', 'Jorge González'],
]);
const resolveAliases = (
  _system: string,
  codes: Array<string | null | undefined>,
) =>
  Promise.resolve(
    new Map(
      codes
        .filter((c): c is string => !!c && ALIASES.has(c))
        .map((c) => [c, ALIASES.get(c) ?? c]),
    ),
  );

/**
 * OC sintéticas de SAP: ahorro (M1) y G2 (M2) con las solicitudes de abajo.
 * La 5 nació en Maximo (PO500 existe allá) y la capturó el usuario de la
 * integración; la 9 es de 2025. O3: Jorge González está marcado como
 * comprador (COMPRADORES_SAP); Ana Pérez no.
 */
const SAP_OC = [
  // Jorge: 10, 20 y 30 días; dos variantes del nombre; MXN y USD
  {
    doc_entry: 1,
    doc_date: d('2026-03-11'),
    currency: 'MXN',
    created_by_name: 'Jorge González',
    maximo_ponum: null,
    ahorro_total: '1000.10',
    subtotal: '900',
    base_request_entries: [100],
  },
  {
    doc_entry: 2,
    doc_date: d('2026-03-21'),
    currency: 'MXN',
    created_by_name: 'JORGE  GONZÁLEZ',
    maximo_ponum: null,
    ahorro_total: '0.20',
    subtotal: '100',
    base_request_entries: [100],
  },
  {
    doc_entry: 3,
    doc_date: d('2026-03-31'),
    currency: 'USD',
    created_by_name: 'Jorge González',
    maximo_ponum: null,
    ahorro_total: '50.25',
    subtotal: '45',
    base_request_entries: [100, 101],
  },
  // sin quien la capturó → "Sin comprador identificado"; 1 día
  {
    doc_entry: 4,
    doc_date: d('2026-03-02'),
    currency: 'MXN',
    created_by_name: null,
    maximo_ponum: null,
    ahorro_total: '300',
    subtotal: null,
    base_request_entries: [102],
  },
  // migrada: su copia de SAP no cuenta en el ahorro (D1); G2 sí (por
  // sistema), con el comprador de Maximo; 7 días
  {
    doc_entry: 5,
    doc_date: d('2026-03-08'),
    currency: 'MXN',
    created_by_name: 'FAVOR DE NO TOCAR USUARIO PP XAMAI',
    maximo_ponum: 'PO500',
    ahorro_total: '700',
    subtotal: '650',
    base_request_entries: [101],
  },
  // Ana Pérez (O3: no es compradora → sin comprador): 4 días; una negativa
  // y una con la solicitud sin sincronizar
  {
    doc_entry: 6,
    doc_date: d('2026-03-05'),
    currency: 'MXN',
    created_by_name: 'Ana Pérez',
    maximo_ponum: null,
    ahorro_total: null,
    subtotal: '200',
    base_request_entries: [101],
  },
  {
    doc_entry: 7,
    doc_date: d('2026-02-01'),
    currency: 'MXN',
    created_by_name: 'Ana Pérez',
    maximo_ponum: null,
    ahorro_total: null,
    subtotal: '300',
    base_request_entries: [101],
  },
  {
    doc_entry: 8,
    doc_date: d('2026-03-10'),
    currency: 'MXN',
    created_by_name: 'Ana Pérez',
    maximo_ponum: null,
    ahorro_total: null,
    subtotal: '50.5',
    base_request_entries: [999],
  },
  // 2025: solo cuenta sin año (10 días)
  {
    doc_entry: 9,
    doc_date: d('2025-11-30'),
    currency: 'MXN',
    created_by_name: 'Jorge González',
    maximo_ponum: null,
    ahorro_total: '99',
    subtotal: '80',
    base_request_entries: [103],
  },
];
const SAP_PR = [
  { doc_entry: 100, doc_date: d('2026-03-01') },
  { doc_entry: 101, doc_date: d('2026-03-01') },
  { doc_entry: 102, doc_date: d('2026-03-01') },
  { doc_entry: 103, doc_date: d('2025-11-20') },
];
/**
 * OC sintéticas de Maximo (vista vigente): ahorro y días de G2 por OC. O3:
 * el comprador es el de la RQ (`rq_buyer`) o el PURCHASEAGENT; quien la
 * creó (`created_by`) ya no cuenta, y la de contrato va a su grupo.
 */
const MAXIMO_OC = [
  // la migrada: comprador de la RQ (alias)
  {
    ponum: 'PO500',
    created_at_source: d('2026-03-08'),
    currency: 'MXN',
    purchase_agent: null,
    purchase_agent_name: null,
    created_by: 'VMM3',
    rq_buyer: 'VMM3',
    rq_buyer_name: 'Victor Martinez M',
    de_contrato: false,
    ab_ahorro: '700',
    subtotal: '620',
    dias: '7',
    dias_desde_aprobacion: '3',
  },
  // con PURCHASEAGENT y sin RQ: manda el agente, no quien la creó
  {
    ponum: 'PO600',
    created_at_source: d('2026-06-01'),
    currency: 'MXN',
    purchase_agent: 'AMONDRAG',
    purchase_agent_name: 'Ana Aurora Mondragón',
    created_by: 'VMM3',
    rq_buyer: null,
    rq_buyer_name: null,
    de_contrato: false,
    ab_ahorro: '2000',
    subtotal: '1800',
    dias: '12',
    dias_desde_aprobacion: '5',
  },
  // comprador de la RQ (alias): la misma persona que el agente de PO600
  {
    ponum: 'PO601',
    created_at_source: d('2026-06-02'),
    currency: 'MXN',
    purchase_agent: null,
    purchase_agent_name: null,
    created_by: 'IVTOG',
    rq_buyer: 'AMONDRAG',
    rq_buyer_name: 'Ana Aurora Mondragon',
    de_contrato: false,
    ab_ahorro: '500.5',
    subtotal: null,
    dias: '20',
    dias_desde_aprobacion: '10',
  },
  {
    ponum: 'PO602',
    created_at_source: d('2026-06-03'),
    currency: 'MXN',
    purchase_agent: null,
    purchase_agent_name: null,
    created_by: 'AMONDRAG',
    rq_buyer: 'AMONDRAG',
    rq_buyer_name: 'Ana Aurora Mondragon',
    de_contrato: false,
    ab_ahorro: '0.1',
    subtotal: '10',
    dias: '16',
    dias_desde_aprobacion: null,
  },
  // Jorge en Maximo (RQ con alias): se junta con el de SAP; sin solicitud (N = 0)
  {
    ponum: 'PO603',
    created_at_source: d('2026-07-01'),
    currency: 'USD',
    purchase_agent: null,
    purchase_agent_name: null,
    created_by: 'JAGS1',
    rq_buyer: 'JAGS1',
    rq_buyer_name: 'Jorge Alberto González Soriano',
    de_contrato: false,
    ab_ahorro: '10',
    subtotal: '9',
    dias: null,
    dias_desde_aprobacion: null,
  },
  // O3: sin RQ ni agente; la creó Víctor ("Capturó") → sin comprador;
  // negativa (descartada) y sin ahorro
  {
    ponum: 'PO604',
    created_at_source: d('2026-07-02'),
    currency: 'MXN',
    purchase_agent: null,
    purchase_agent_name: null,
    created_by: 'VMM3',
    rq_buyer: null,
    rq_buyer_name: null,
    de_contrato: false,
    ab_ahorro: null,
    subtotal: '400',
    dias: '-2',
    dias_desde_aprobacion: '-1',
  },
  // sin RQ, agente ni creador → sin comprador
  {
    ponum: 'PO605',
    created_at_source: d('2026-07-03'),
    currency: 'MXN',
    purchase_agent: null,
    purchase_agent_name: null,
    created_by: null,
    rq_buyer: null,
    rq_buyer_name: null,
    de_contrato: false,
    ab_ahorro: null,
    subtotal: '70',
    dias: '3',
    dias_desde_aprobacion: '2',
  },
  // 2025: solo cuenta sin año
  {
    ponum: 'PO606',
    created_at_source: d('2025-07-01'),
    currency: 'MXN',
    purchase_agent: null,
    purchase_agent_name: null,
    created_by: 'AMONDRAG',
    rq_buyer: 'AMONDRAG',
    rq_buyer_name: null,
    de_contrato: false,
    ab_ahorro: '42',
    subtotal: '40',
    dias: '30',
    dias_desde_aprobacion: '20',
  },
  // O3: de contrato (CONTRACTREFNUM), la capturó quien no es comprador →
  // "OC de contrato"
  {
    ponum: 'PO607',
    created_at_source: d('2026-08-03'),
    currency: 'MXN',
    purchase_agent: null,
    purchase_agent_name: null,
    created_by: 'ACXA1',
    rq_buyer: null,
    rq_buyer_name: null,
    de_contrato: true,
    ab_ahorro: '25',
    subtotal: '5000',
    dias: '9',
    dias_desde_aprobacion: '4',
  },
];

/** O3: lo que trae cada consulta de Maximo para su comprador. */
const mxBuyer = (o: (typeof MAXIMO_OC)[number]) => ({
  purchase_agent: o.purchase_agent,
  purchase_agent_name: o.purchase_agent_name,
  de_contrato: o.de_contrato,
  rq_buyer: o.rq_buyer,
  rq_buyer_name: o.rq_buyer_name,
});

/** D1 tal como lo arma `andSapPoCountedOnce('po')` (texto normalizado). */
const D1_SAP_PO =
  'AND NOT (po.maximo_ponum IS NOT NULL AND EXISTS ( SELECT 1 FROM maximo_purchase_orders m WHERE m.ponum = po.maximo_ponum))';

const norm = (sql: string) => sql.replace(/\s+/g, ' ');

/** GROUP BY de juguete: suma como numeric de Postgres (texto a centavos). */
function groupBy<T>(
  rows: T[],
  keyOf: (row: T) => Record<string, unknown>,
  amountOf: (row: T) => number,
) {
  const groups = new Map<
    string,
    { key: Record<string, unknown>; total: number; count: number }
  >();
  for (const row of rows) {
    const key = keyOf(row);
    const id = JSON.stringify(key);
    const group = groups.get(id) ?? { key, total: 0, count: 0 };
    group.total += amountOf(row);
    group.count += 1;
    groups.set(id, group);
  }
  return [...groups.values()].map((g) => ({
    ...g.key,
    total: g.total.toFixed(2),
    count: g.count,
  }));
}

/**
 * "Postgres de juguete" para las consultas de M1/M2: agrupa como el SQL y
 * aplica el año (los Date de `values`) y D1 SOLO si el SQL los trae. Lo
 * demás (resto del tablero) sale vacío.
 */
function fakeDb(q: FakeQuery): unknown[] {
  const sql = norm(q.sql);
  const [from, to] = q.values.filter((v): v is Date => v instanceof Date);
  const inPeriod = (date: Date) => !from || (date >= from && date < to);
  const enMaximo = new Set(MAXIMO_OC.map((m) => m.ponum));
  // D1 tal como lo arma cada consulta (alias `po` o la tabla)
  const sapCountedOnce = (o: (typeof SAP_OC)[number]) =>
    !(
      (sql.includes(D1_SAP_PO) ||
        sql.includes(
          'sap_purchase_orders.maximo_ponum IS NOT NULL AND EXISTS',
        )) &&
      o.maximo_ponum !== null &&
      enMaximo.has(o.maximo_ponum)
    );
  /** GROUP BY con el subtotal sin IVA (poSubtotalColumns). */
  const groupSubtotal = <T extends { subtotal: string | null }>(
    rows: T[],
    keyOf: (row: T) => Record<string, unknown>,
  ) => {
    const groups = new Map<
      string,
      {
        key: Record<string, unknown>;
        subtotal: number;
        sin_subtotal: number;
        count: number;
      }
    >();
    for (const row of rows) {
      const key = keyOf(row);
      const id = JSON.stringify(key);
      const g = groups.get(id) ?? {
        key,
        subtotal: 0,
        sin_subtotal: 0,
        count: 0,
      };
      if (row.subtotal === null) g.sin_subtotal += 1;
      else g.subtotal += Number(row.subtotal);
      g.count += 1;
      groups.set(id, g);
    }
    return [...groups.values()].map((g) => ({
      ...g.key,
      total: '0',
      subtotal: g.subtotal.toFixed(2),
      sin_subtotal: g.sin_subtotal,
      count: g.count,
    }));
  };
  // N3: primera OC con ahorro de cada sistema
  if (sql.includes('min(po.doc_date)')) {
    const sapDates = SAP_OC.filter(
      (o) => o.ahorro_total !== null && sapCountedOnce(o),
    ).map((o) => o.doc_date.getTime());
    const mxDates = MAXIMO_OC.filter((o) => o.ab_ahorro !== null).map((o) =>
      o.created_at_source.getTime(),
    );
    return [
      {
        sap: sapDates.length ? new Date(Math.min(...sapDates)) : null,
        maximo: mxDates.length ? new Date(Math.min(...mxDates)) : null,
      },
    ];
  }
  // N1: OC de SAP sin IVA por quien la capturó
  if (sql.includes('sum(po.subtotal)')) {
    return groupSubtotal(
      SAP_OC.filter((o) => inPeriod(o.doc_date) && sapCountedOnce(o)),
      (o) => ({ currency: o.currency, created_by_name: o.created_by_name }),
    );
  }
  // N1: OC de Maximo sin IVA por comprador (O3: RQ, agente y contrato)
  if (sql.includes('sum(c.subtotal)') && sql.includes('c.purchase_agent')) {
    return groupSubtotal(
      MAXIMO_OC.filter((o) => inPeriod(o.created_at_source)),
      (o) => ({ currency: o.currency, ...mxBuyer(o) }),
    );
  }
  // tablero: tarjeta de Órdenes (SAP y Maximo), con su subtotal
  if (sql.includes('sum(sap_purchase_orders.subtotal)')) {
    return groupSubtotal(
      SAP_OC.filter((o) => inPeriod(o.doc_date) && sapCountedOnce(o)),
      (o) => ({ currency: o.currency }),
    );
  }
  // (se reconoce por agrupar solo por moneda, no por la base del monto, que
  // puede cambiar con TABLERO_MONTO_BASE)
  if (
    sql.includes('sum(c.subtotal)') &&
    !sql.includes('c.purchase_agent') &&
    sql.includes('GROUP BY c.currency')
  ) {
    return groupSubtotal(
      MAXIMO_OC.filter((o) => inPeriod(o.created_at_source)),
      (o) => ({ currency: o.currency }),
    );
  }
  if (sql.includes('po.ahorro_total IS NOT NULL')) {
    const d1 = sql.includes(D1_SAP_PO);
    return groupBy(
      SAP_OC.filter(
        (o) =>
          o.ahorro_total !== null &&
          inPeriod(o.doc_date) &&
          !(d1 && o.maximo_ponum !== null && enMaximo.has(o.maximo_ponum)),
      ),
      (o) => ({ currency: o.currency, created_by_name: o.created_by_name }),
      (o) => Number(o.ahorro_total),
    );
  }
  if (sql.includes('ab_ahorro IS NOT NULL')) {
    return groupBy(
      MAXIMO_OC.filter(
        (o) => o.ab_ahorro !== null && inPeriod(o.created_at_source),
      ),
      (o) => ({ currency: o.currency, ...mxBuyer(o) }),
      (o) => Number(o.ab_ahorro),
    );
  }
  if (sql.includes('cardinality(base_request_entries) > 0')) {
    return SAP_OC.filter(
      (o) => o.base_request_entries.length > 0 && inPeriod(o.doc_date),
    ).map((o) => ({
      doc_entry: o.doc_entry,
      doc_date: o.doc_date,
      base_request_entries: o.base_request_entries,
      created_by_name: o.created_by_name,
      maximo_ponum: o.maximo_ponum,
    }));
  }
  if (sql.includes('FROM sap_purchase_requests WHERE doc_entry IN')) {
    return SAP_PR.filter((p) => q.values.includes(p.doc_entry));
  }
  if (sql.includes('SELECT m.ponum, m.purchase_agent')) {
    return MAXIMO_OC.filter((m) => q.values.includes(m.ponum)).map((m) => ({
      ponum: m.ponum,
      created_by: m.created_by,
      ...mxBuyer(m),
    }));
  }
  if (sql.includes('AS dias_desde_aprobacion')) {
    // O3: el comprador solo viene si la consulta lo pide (Órdenes)
    const conComprador = sql.includes('rq.rq_buyer');
    return MAXIMO_OC.filter((m) => inPeriod(m.created_at_source)).map((m) => ({
      dias: m.dias,
      dias_desde_aprobacion: m.dias_desde_aprobacion,
      ponum: m.ponum,
      purchase_agent: m.purchase_agent,
      purchase_agent_name: m.purchase_agent_name,
      created_by: m.created_by,
      ...(conComprador ? mxBuyer(m) : {}),
    }));
  }
  return [];
}

function makeFakeService() {
  const harness = makeService();
  harness.queryRaw.mockImplementation((q: FakeQuery) =>
    Promise.resolve(fakeDb(q)),
  );
  harness.resolveMany.mockImplementation(resolveAliases);
  return harness;
}

const queriesOf = (queryRaw: jest.Mock) =>
  (queryRaw.mock.calls as unknown as Array<[FakeQuery]>).map(([q]) => q);

/** Σ de las barras por moneda: monto (a centavos) y OC. */
function sumOfBars(
  bars: Array<{
    por_moneda: Array<{
      currency: string | null;
      total: number;
      count: number;
    }>;
  }>,
) {
  const byCurrency = new Map<string | null, { total: number; count: number }>();
  for (const bar of bars) {
    for (const m of bar.por_moneda) {
      const acc = byCurrency.get(m.currency) ?? { total: 0, count: 0 };
      acc.total += m.total;
      acc.count += m.count;
      byCurrency.set(m.currency, acc);
    }
  }
  return [...byCurrency.entries()]
    .map(([currency, a]) => ({
      currency,
      total: Math.round(a.total * 100) / 100,
      count: a.count,
    }))
    .sort((a, b) => (a.currency ?? '').localeCompare(b.currency ?? ''));
}
const byCurrencyCode = <T extends { currency: string | null }>(list: T[]) =>
  [...list].sort((a, b) => (a.currency ?? '').localeCompare(b.currency ?? ''));

/** Promedio ponderado por N de las barras y Σ N. */
function weighted(
  list: Array<{ promedio_dias: number | null; total: number }>,
) {
  const n = list.reduce((s, g) => s + g.total, 0);
  const dias = list.reduce((s, g) => s + (g.promedio_dias ?? 0) * g.total, 0);
  return { n, promedio: n === 0 ? null : dias / n };
}

describe('Bloque M: ahorro por comprador (M1)', () => {
  it.each([
    {
      year: 2026,
      mxn: { currency: 'MXN', total: 4525.9, count: 8 },
      ana: { currency: 'MXN', total: 2500.6, count: 3 },
      jorgeMxn: { currency: 'MXN', total: 1000.3, count: 2 },
    },
    {
      year: null,
      mxn: { currency: 'MXN', total: 4666.9, count: 10 },
      ana: { currency: 'MXN', total: 2542.6, count: 4 },
      jorgeMxn: { currency: 'MXN', total: 1099.3, count: 3 },
    },
  ])(
    'año $year: por moneda, la suma de las barras = la tarjeta; la migrada una vez y con el comprador de Maximo',
    async ({ year, mxn, ana, jorgeMxn }) => {
      const { service, queryRaw, resolveMany } = makeFakeService();
      const kpis = await service.getOrdersKpis(year);
      const { ahorro } = kpis;

      expect(ahorro.disponible).toBe(true);
      expect(ahorro.por_moneda).toEqual([
        mxn,
        { currency: 'USD', total: 60.25, count: 2 },
      ]);
      // la suma de las barras = la tarjeta, por moneda (monto y OC)
      expect(sumOfBars(ahorro.por_comprador)).toEqual(
        byCurrencyCode(ahorro.por_moneda),
      );
      expect(ahorro.por_comprador.reduce((s, b) => s + b.documentos, 0)).toBe(
        ahorro.documentos,
      );
      expect(
        ahorro.por_fuente.sap.documentos + ahorro.por_fuente.maximo.documentos,
      ).toBe(ahorro.documentos);

      // la migrada (PO500) cuenta UNA vez, del lado de Maximo y con el
      // comprador de su RQ; nunca el usuario de la integración de SAP
      expect(
        ahorro.por_comprador.filter((b) => b.comprador === 'Víctor Martínez'),
      ).toEqual([
        {
          comprador: 'Víctor Martínez',
          grupo: 'persona',
          tipo: 'comprador',
          documentos: 1,
          documentos_capturo: 0,
          por_moneda: [{ currency: 'MXN', total: 700, count: 1 }],
        },
      ]);
      expect(
        ahorro.por_comprador.some((b) => /XAMAI/.test(b.comprador ?? '')),
      ).toBe(false);

      // Ana: PURCHASEAGENT en una y comprador de la RQ en las demás (alias)
      expect(ahorro.por_comprador[0]).toMatchObject({
        comprador: 'Ana Aurora Mondragón',
        grupo: 'persona',
        tipo: 'comprador',
        documentos: ana.count,
        documentos_capturo: 0,
        por_moneda: [ana],
      });
      // Jorge: SAP (dos variantes, marcado) + Maximo (RQ con alias) en una
      // sola barra
      expect(ahorro.por_comprador[1]).toMatchObject({
        comprador: 'Jorge González',
        tipo: 'capturo',
        por_moneda: [jorgeMxn, { currency: 'USD', total: 60.25, count: 2 }],
      });
      // al final, en gris: sin comprador (sin quien la capturó) y las de
      // contrato (O3)
      expect(ahorro.por_comprador.at(-2)).toEqual({
        comprador: null,
        grupo: 'sin_comprador',
        tipo: null,
        documentos: 1,
        documentos_capturo: 0,
        por_moneda: [{ currency: 'MXN', total: 300, count: 1 }],
      });
      expect(ahorro.por_comprador.at(-1)).toEqual({
        comprador: null,
        grupo: 'contrato',
        tipo: null,
        documentos: 1,
        documentos_capturo: 0,
        por_moneda: [{ currency: 'MXN', total: 25, count: 1 }],
      });
      expect(resolveMany).toHaveBeenCalledWith(
        'maximo',
        expect.arrayContaining(['AMONDRAG', 'VMM3', 'JAGS1']),
      );

      // SQL: SAP con D1 y agrupado por quien capturó; Maximo sin D1 (ahí
      // cuenta la migrada) y agrupado por su comprador de O3 (agente, RQ y
      // contrato, leídos del raw); el año va en los parámetros (rango
      // [1-ene, 1-ene siguiente))
      const queries = queriesOf(queryRaw);
      const sapAhorro = queries.filter(
        (q) =>
          q.sql.includes('po.ahorro_total IS NOT NULL') &&
          !q.sql.includes('min(po.doc_date)'),
      );
      const maximoAhorro = queries.filter(
        (q) =>
          q.sql.includes('ab_ahorro IS NOT NULL') &&
          !q.sql.includes('min(po.doc_date)'),
      );
      expect(sapAhorro).toHaveLength(1);
      expect(maximoAhorro).toHaveLength(1);
      expect(norm(sapAhorro[0].sql)).toContain(D1_SAP_PO);
      expect(norm(sapAhorro[0].sql)).toContain(
        'GROUP BY po.currency, po.created_by_name',
      );
      expect(maximoAhorro[0].sql).not.toContain('maximo_ponum');
      expect(norm(maximoAhorro[0].sql)).toContain('GROUP BY 1, 2, 3, 4, 5, 6');
      expect(maximoAhorro[0].sql).toContain('RFQSTATUS');
      expect(maximoAhorro[0].sql).toContain('CONTRACTREFNUM');
      const bounds =
        year === null
          ? []
          : [
              new Date(Date.UTC(year, 0, 1)),
              new Date(Date.UTC(year + 1, 0, 1)),
            ];
      expect(sapAhorro[0].values).toEqual(bounds);
      expect(maximoAhorro[0].values).toEqual(bounds);
    },
  );

  it('sin el filtro D1 la migrada contaría dos veces (el juguete solo descuenta si el SQL lo trae)', () => {
    const sql = (withD1: boolean) => ({
      sql: `SELECT ... WHERE po.ahorro_total IS NOT NULL ${withD1 ? D1_SAP_PO : ''}`,
      values: [],
    });
    const xamai = (rows: unknown[]) =>
      (rows as Array<{ created_by_name: string | null }>).some(
        (r) => r.created_by_name === 'FAVOR DE NO TOCAR USUARIO PP XAMAI',
      );
    expect(xamai(fakeDb(sql(true)))).toBe(false);
    expect(xamai(fakeDb(sql(false)))).toBe(true);
  });
});

describe('Bloque M: tiempo de gestión por comprador (M2)', () => {
  it.each([2026, null])(
    'año %p: Σ N por comprador = N de G2 del tablero y el promedio ponderado por N = el del tablero (SAP, Maximo y desde la aprobación)',
    async (year) => {
      const { service, queryRaw } = makeFakeService();
      const summary = await service.getSummary(year);
      const summaryQueries = queriesOf(queryRaw).length;
      const kpis = await service.getOrdersKpis(year);
      const g = kpis.gestion_por_comprador;
      const queries = queriesOf(queryRaw);

      const checks = [
        [g.sap.compradores, summary.dias_gestion.sap],
        [g.maximo.compradores, summary.dias_gestion.maximo],
        [
          g.maximo.compradores.map((c) => ({
            promedio_dias: c.desde_aprobacion?.promedio_dias ?? null,
            total: c.desde_aprobacion?.total ?? 0,
          })),
          summary.dias_gestion.maximo_desde_aprobacion,
        ],
      ] as const;
      for (const [compradores, tablero] of checks) {
        const { n, promedio } = weighted([...compradores]);
        expect(tablero.total).toBeGreaterThan(0);
        expect(n).toBe(tablero.total);
        expect(
          Math.abs((promedio ?? Number.NaN) - (tablero.promedio_dias ?? 0)),
        ).toBeLessThanOrEqual(0.05);
      }

      // el total de cada sistema es el mismo resultado de G2 del tablero
      expect({
        ...g.sap.total,
        definicion: summary.dias_gestion.sap.definicion,
      }).toEqual(summary.dias_gestion.sap);
      expect({
        ...g.maximo.total,
        definicion: summary.dias_gestion.maximo.definicion,
      }).toEqual(summary.dias_gestion.maximo);
      expect({
        ...g.maximo.total_desde_aprobacion,
        definicion: g.maximo.definicion_secundaria,
      }).toEqual(summary.dias_gestion.maximo_desde_aprobacion);
      expect(g.min_oc).toBe(3);

      // mismo periodo y mismas OC: las consultas de G2 son las mismas; la de
      // Maximo de Órdenes solo agrega el comprador de O3 (columnas del raw)
      const g2 = (list: FakeQuery[]) =>
        list
          .filter(
            (q) =>
              q.sql.includes('cardinality(base_request_entries) > 0') ||
              q.sql.includes('AS dias_desde_aprobacion') ||
              norm(q.sql).includes(
                'FROM sap_purchase_requests WHERE doc_entry IN',
              ),
          )
          .map((q) => ({
            sql: q.sql.includes('AS dias_desde_aprobacion')
              ? 'G2 de Maximo'
              : q.sql,
            values: q.values,
          }))
          .sort((a, b) => a.sql.localeCompare(b.sql));
      expect(g2(queries.slice(summaryQueries))).toHaveLength(3);
      expect(g2(queries.slice(summaryQueries))).toEqual(
        g2(queries.slice(0, summaryQueries)),
      );
      const mxG2 = (list: FakeQuery[]) =>
        list.filter((q) => q.sql.includes('AS dias_desde_aprobacion'));
      expect(mxG2(queries.slice(summaryQueries))[0].sql).toContain(
        'rq.rq_buyer',
      );
      expect(mxG2(queries.slice(0, summaryQueries))[0].sql).not.toContain(
        'rq_buyer',
      );
      // la migrada de SAP busca su comprador en Maximo por PONUM
      const porPonum = queries.filter((q) =>
        q.sql.includes('SELECT m.ponum, m.purchase_agent'),
      );
      expect(porPonum.map((q) => q.values)).toEqual([['PO500']]);
    },
  );

  it('2026: barras de SAP y Maximo con su N, en orden; la migrada con el comprador de Maximo; sin comprador y contrato al final', async () => {
    const { service } = makeFakeService();
    const { gestion_por_comprador: g } = await service.getOrdersKpis(2026);
    // SAP: 6 OC (10, 20, 30, 1, 7 y 4 días) → 12 días; 2 descartadas
    expect(g.sap.total).toEqual({
      promedio_dias: 12,
      mediana_dias: 8.5,
      total: 6,
      descartadas: 2,
    });
    expect(g.sap.compradores).toEqual([
      {
        comprador: 'Jorge González',
        grupo: 'persona',
        tipo: 'capturo',
        documentos_capturo: 3,
        promedio_dias: 20,
        mediana_dias: 20,
        total: 3,
        descartadas: 0,
      },
      // N < 3: después. La OC 5 la capturó la integración: comprador de
      // Maximo (el de la RQ de PO500)
      {
        comprador: 'Víctor Martínez',
        grupo: 'persona',
        tipo: 'comprador',
        documentos_capturo: 0,
        promedio_dias: 7,
        mediana_dias: 7,
        total: 1,
        descartadas: 0,
      },
      // O3: sin quien la capturó (1 día) y las de Ana Pérez, que no es
      // compradora (4 días y dos descartadas)
      {
        comprador: null,
        grupo: 'sin_comprador',
        tipo: null,
        documentos_capturo: 0,
        promedio_dias: 2.5,
        mediana_dias: 2.5,
        total: 2,
        descartadas: 2,
      },
    ]);
    // Maximo: 12, 20, 16, 7, 3 y 9 días → 11.2; Jorge (solo una OC sin
    // solicitud) no tiene barra
    expect(g.maximo.total).toMatchObject({
      promedio_dias: 11.2,
      mediana_dias: 10.5,
      total: 6,
      descartadas: 1,
      sin_solicitud: 1,
    });
    expect(g.maximo.total_desde_aprobacion).toMatchObject({
      promedio_dias: 4.8,
      total: 5,
    });
    expect(g.maximo.compradores).toEqual([
      {
        comprador: 'Ana Aurora Mondragón',
        grupo: 'persona',
        tipo: 'comprador',
        documentos_capturo: 0,
        promedio_dias: 16,
        mediana_dias: 16,
        total: 3,
        descartadas: 0,
        sin_solicitud: 0,
        desde_aprobacion: { promedio_dias: 7.5, mediana_dias: 7.5, total: 2 },
      },
      {
        comprador: 'Víctor Martínez',
        grupo: 'persona',
        tipo: 'comprador',
        documentos_capturo: 0,
        promedio_dias: 7,
        mediana_dias: 7,
        total: 1,
        descartadas: 0,
        sin_solicitud: 0,
        desde_aprobacion: { promedio_dias: 3, mediana_dias: 3, total: 1 },
      },
      // O3: PO604 (solo "Capturó", descartada) y PO605 (nadie)
      {
        comprador: null,
        grupo: 'sin_comprador',
        tipo: null,
        documentos_capturo: 0,
        promedio_dias: 3,
        mediana_dias: 3,
        total: 1,
        descartadas: 1,
        sin_solicitud: 0,
        desde_aprobacion: { promedio_dias: 2, mediana_dias: 2, total: 1 },
      },
      {
        comprador: null,
        grupo: 'contrato',
        tipo: null,
        documentos_capturo: 0,
        promedio_dias: 9,
        mediana_dias: 9,
        total: 1,
        descartadas: 0,
        sin_solicitud: 0,
        desde_aprobacion: { promedio_dias: 4, mediana_dias: 4, total: 1 },
      },
    ]);
  });

  it('sin OC con solicitud → totales sin base (null, nunca 0) y sin barras', async () => {
    const { service, queryRaw } = makeService();
    queryRaw.mockResolvedValue([]);
    const { gestion_por_comprador: g } = await service.getOrdersKpis(2026);
    expect(g.sap.total).toEqual({
      promedio_dias: null,
      mediana_dias: null,
      total: 0,
      descartadas: 0,
    });
    expect(g.maximo.total.promedio_dias).toBeNull();
    expect(g.sap.compradores).toEqual([]);
    expect(g.maximo.compradores).toEqual([]);
  });
});

/** N1: Σ por moneda del adjudicado (monto a centavos, OC y OC sin subtotal). */
function sumAdj(
  lists: Array<
    Array<{
      currency: string | null;
      total?: number;
      subtotal?: number;
      count: number;
      sin_subtotal?: number;
    }>
  >,
  field: 'total' | 'subtotal',
) {
  const map = new Map<
    string | null,
    { total: number; count: number; sin_subtotal: number }
  >();
  for (const list of lists) {
    for (const m of list) {
      const acc = map.get(m.currency) ?? {
        total: 0,
        count: 0,
        sin_subtotal: 0,
      };
      acc.total = Math.round((acc.total + (m[field] ?? 0)) * 100) / 100;
      acc.count += m.count;
      acc.sin_subtotal += m.sin_subtotal ?? 0;
      map.set(m.currency, acc);
    }
  }
  return [...map.entries()]
    .map(([currency, a]) => ({ currency, ...a }))
    .sort((a, b) => (a.currency ?? '').localeCompare(b.currency ?? ''));
}

describe('Bloque N: monto adjudicado y ahorro por persona (N1)', () => {
  it.each([2026, null])(
    'año %p: Σ adjudicado por persona = total sin IVA de Órdenes = tarjeta de Órdenes del tablero; Σ ahorro = "Ahorro acumulado"',
    async (year) => {
      const { service } = makeFakeService();
      const kpis = await service.getOrdersKpis(year);
      const summary = await service.getSummary(year);

      const barras = sumAdj(
        kpis.compradores.map((c) => c.adjudicado),
        'total',
      );
      expect(barras).toEqual(sumAdj([kpis.adjudicado.por_moneda], 'total'));
      // la misma base que la tarjeta de Órdenes del tablero (SAP + Maximo,
      // subtotal sin IVA, OC y OC sin subtotal)
      expect(barras).toEqual(
        sumAdj(
          [
            summary.ordenes.por_fuente.sap.monto_por_moneda,
            summary.ordenes.por_fuente.maximo.monto_por_moneda,
          ],
          'subtotal',
        ),
      );
      // el ahorro por persona = la tarjeta "Ahorro acumulado"
      expect(sumOfBars(kpis.compradores.map((c) => c.ahorro))).toEqual(
        byCurrencyCode(kpis.ahorro.por_moneda).map(
          ({ currency, total, count }) => ({ currency, total, count }),
        ),
      );
    },
  );

  it('2026: orden por adjudicado en MXN; la migrada una vez (del lado de Maximo); sin comprador y OC de contrato al final', async () => {
    const { service, queryRaw } = makeFakeService();
    const kpis = await service.getOrdersKpis(2026);
    expect(
      kpis.compradores.map((c) => [
        c.comprador,
        c.grupo,
        c.adjudicado.find((m) => m.currency === 'MXN'),
      ]),
    ).toEqual([
      // PO600 1,800 + PO602 10; PO601 sin subtotal: cuenta en OC, no en el monto
      [
        'Ana Aurora Mondragón',
        'persona',
        { currency: 'MXN', total: 1810, count: 3, sin_subtotal: 1 },
      ],
      [
        'Jorge González',
        'persona',
        { currency: 'MXN', total: 1000, count: 2, sin_subtotal: 0 },
      ],
      // PO500 620 (la copia de SAP, OC 5, no se cuenta: D1)
      [
        'Víctor Martínez',
        'persona',
        { currency: 'MXN', total: 620, count: 1, sin_subtotal: 0 },
      ],
      // O3: Ana Pérez (no es compradora) 550.5, PO604 (solo "Capturó") 400,
      // PO605 70 y la OC 4 de SAP sin subtotal
      [
        null,
        'sin_comprador',
        { currency: 'MXN', total: 1020.5, count: 6, sin_subtotal: 1 },
      ],
      // O3: la de contrato aparte, aunque la capturó alguien
      [
        null,
        'contrato',
        { currency: 'MXN', total: 5000, count: 1, sin_subtotal: 0 },
      ],
    ]);
    expect(kpis.compradores.at(-1)?.ahorro).toEqual({
      documentos: 1,
      por_moneda: [{ currency: 'MXN', total: 25, count: 1 }],
    });
    expect(kpis.comprador).toEqual({
      desde_anio: 2026,
      aviso: null,
      compradores_sap: [
        'Ingrid Torres Gutiérrez',
        'Diana Yohara Méndez',
        'Jorge González',
        'Ana Daniela Contreras Sánchez',
      ],
    });
    const jorge = kpis.compradores.find(
      (c) => c.comprador === 'Jorge González',
    );
    expect(jorge?.adjudicado).toContainEqual({
      currency: 'USD',
      total: 54,
      count: 2,
      sin_subtotal: 0,
    });
    expect(kpis.adjudicado.monto_base).toBe('sin_iva');
    // SQL: SAP con D1 y el año en los parámetros; Maximo sin D1
    const queries = queriesOf(queryRaw);
    const sapAdj = queries.filter((q) => q.sql.includes('sum(po.subtotal)'));
    const mxAdj = queries.filter(
      (q) =>
        q.sql.includes('sum(c.subtotal)') && q.sql.includes('c.purchase_agent'),
    );
    expect(sapAdj).toHaveLength(1);
    expect(mxAdj).toHaveLength(1);
    expect(norm(sapAdj[0].sql)).toContain(D1_SAP_PO);
    expect(mxAdj[0].sql).not.toContain('maximo_ponum');
    const bounds = [d('2026-01-01'), d('2027-01-01')];
    expect(sapAdj[0].values).toEqual(bounds);
    expect(mxAdj[0].values).toEqual(bounds);
  });

  it('N3: ahorro capturado desde = la primera OC con ahorro de cada sistema (sin año y contando una vez)', async () => {
    const { service } = makeFakeService();
    const kpis = await service.getOrdersKpis(2026);
    expect(kpis.ahorro.desde).toEqual({
      sap: '2025-11-30T00:00:00.000Z',
      maximo: '2025-07-01T00:00:00.000Z',
    });
  });

  it('sin OC → adjudicado no disponible, sin personas y sin fecha de ahorro', async () => {
    const { service, queryRaw } = makeService();
    queryRaw.mockResolvedValue([]);
    const kpis = await service.getOrdersKpis(2026);
    expect(kpis.adjudicado).toMatchObject({
      disponible: false,
      documentos: 0,
      por_moneda: [],
    });
    expect(kpis.compradores).toEqual([]);
    expect(kpis.ahorro.desde).toEqual({ sap: null, maximo: null });
  });
});

describe('Bloque N: la misma persona entre SAP y Maximo (N2)', () => {
  /** Jorge con un alias corto ligado a su perfil, que se llama como en SAP. */
  function withLinkedJorge(linked: boolean) {
    const harness = makeFakeService();
    harness.resolveMany.mockImplementation(
      (_s: string, codes: Array<string | null | undefined>) =>
        resolveAliases(_s, codes).then(
          (names) =>
            new Map(
              [...names].map(([code, name]) => [
                code,
                code === 'JAGS1' ? 'Jorge G.' : name,
              ]),
            ),
        ),
    );
    harness.byCode.mockResolvedValue(
      new Map([
        [
          'jags1',
          {
            code: 'JAGS1',
            display_name: 'Jorge G.',
            profile_id: linked ? 'p-jorge' : null,
          },
        ],
      ]),
    );
    harness.profilesFindMany.mockResolvedValue(
      linked
        ? [{ id: 'p-jorge', full_name: 'Jorge González', is_active: true }]
        : [],
    );
    return harness;
  }

  it('con el alias ligado al perfil: una sola persona aunque SAP y Maximo escriban su nombre distinto; sin ligar, dos', async () => {
    const ligado = await withLinkedJorge(true).service.getOrdersKpis(2026);
    expect(
      ligado.compradores
        .filter((c) => /jorge/i.test(c.comprador ?? ''))
        .map((c) => [c.comprador, c.documentos]),
    ).toEqual([['Jorge González', 4]]);

    const suelto = await withLinkedJorge(false).service.getOrdersKpis(2026);
    expect(
      suelto.compradores
        .filter((c) => /jorge/i.test(c.comprador ?? ''))
        .map((c) => [c.comprador, c.documentos])
        .sort(),
    ).toEqual([
      ['Jorge G.', 1],
      ['Jorge González', 3],
    ]);
  });

  it('"Ambos": N = SAP + Maximo; promedio y mediana de los días de cada OC; orden por gestiones', async () => {
    const { service } = makeFakeService();
    const { gestion_por_comprador: g } = await service.getOrdersKpis(2026);
    // SAP 10, 20, 30, 1, 7, 4 y Maximo 12, 20, 16, 7, 3, 9 → 12 OC
    expect(g.ambos.total).toEqual({
      promedio_dias: 11.6,
      mediana_dias: 9.5,
      total: 12,
      sap: 6,
      maximo: 6,
    });
    expect(g.ambos.total.total).toBe(g.sap.total.total + g.maximo.total.total);
    expect(
      g.ambos.compradores.map((c) => [
        c.comprador,
        c.total,
        c.sap,
        c.maximo,
        c.promedio_dias,
        c.mediana_dias,
      ]),
    ).toEqual([
      // N ≥ 3 por gestiones; empate: el más rápido primero
      ['Ana Aurora Mondragón', 3, 0, 3, 16, 16],
      ['Jorge González', 3, 3, 0, 20, 20],
      // Víctor: la OC 5 de SAP (comprador de Maximo) y PO500
      ['Víctor Martínez', 2, 1, 1, 7, 7],
      // O3: sin comprador (SAP 1 y 4 días, Maximo 3) y la de contrato (9)
      [null, 3, 2, 1, 2.7, 3],
      [null, 1, 0, 1, 9, 9],
    ]);
    expect(g.ambos.compradores.map((c) => c.grupo).slice(-2)).toEqual([
      'sin_comprador',
      'contrato',
    ]);
  });
});
