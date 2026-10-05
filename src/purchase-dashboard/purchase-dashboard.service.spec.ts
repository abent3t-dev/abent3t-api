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
 */
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
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
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  const config = {
    get: (key: string) =>
      key === 'SAP_SYNC_ENABLED'
        ? sapEnabled
        : key === 'MAXIMO_SYNC_ENABLED'
          ? false
          : undefined,
  } as unknown as ConfigService;
  return { service: new PurchaseDashboardService(prisma, config), queryRaw };
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
