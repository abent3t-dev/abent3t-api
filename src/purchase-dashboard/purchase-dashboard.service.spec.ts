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
 */
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PurchaseDashboardService } from './purchase-dashboard.service';

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
      // sapPr count
      .mockResolvedValueOnce([{ total: 309, pendientes: 12 }])
      // sapPrDias
      .mockResolvedValueOnce([{ dias: '8.44' }])
      // sapPo por moneda (la consulta ya excluye las migradas que existen en Maximo)
      .mockResolvedValueOnce([
        { currency: 'MXN', total: '1000.50', count: 3000 },
        { currency: 'USD', total: '20', count: 5 },
      ])
      // sapPoOpen
      .mockResolvedValueOnce([{ currency: 'MXN', total: '100', count: 750 }])
      // maximoPr
      .mockResolvedValueOnce([{ total: 6, pendientes: 2 }])
      // maximoPoDias (sin base)
      .mockResolvedValueOnce([{ dias: null }])
      // maximoPo
      .mockResolvedValueOnce([{ currency: 'MXN', total: '50', count: 7 }])
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
      pendientes: 14,
      por_fuente: {
        sap: { total: 309, pendientes: 12 },
        maximo: { total: 6, pendientes: 2 },
        abent: { total: 0, pendientes: 0 },
      },
    });
    // Misma moneda se suma entre fuentes; USD queda aparte; ABENT vacío no aparece
    expect(summary.ordenes.total).toBe(3012);
    expect(summary.ordenes.monto_por_moneda).toEqual([
      { currency: 'MXN', total: 1050.5, count: 3007 },
      { currency: 'USD', total: 20, count: 5 },
    ]);
    // D1: desglose de migradas visible (descontadas = las que existen en Maximo)
    expect(summary.ordenes.migradas).toEqual({ total: 1597, en_maximo: 1500 });
    expect(summary.por_recibir.total).toBe(752);
    expect(summary.por_recibir.monto_por_moneda).toEqual([
      { currency: 'MXN', total: 110, count: 752 },
    ]);
    // Días: redondeo a 1 decimal; null cuando no hay base (nunca 0).
    // D3: SAP OC = (10 + 20) / 2 = 15 días, N = 2
    expect(summary.dias_gestion).toEqual({
      sap_solicitudes: 8.4,
      sap_ordenes: 15,
      maximo_ordenes: null,
      abent_requisiciones: null,
    });
    expect(summary.dias_gestion_base.sap_ordenes.total).toBe(2);
    expect(summary.datos.sap_desde).toBe('2023-12-31T00:00:00.000Z');
    expect(summary.datos.anios).toEqual([2026, 2025]);
    expect(summary.datos.ultima_sync.maximo).toBeNull();
    expect(summary.fuentes).toEqual({
      sap_sync_enabled: true,
      maximo_sync_enabled: false,
    });
    expect(queryRaw).toHaveBeenCalledTimes(17);
  });

  it('D1: la consulta de OC de SAP descuenta las migradas que existen en Maximo', async () => {
    const { service, queryRaw } = makeService();
    queryRaw.mockResolvedValue([]);
    await service.getSummary(2025);
    const calls = queryRaw.mock.calls as unknown as Array<
      [{ strings?: string[] } | string]
    >;
    const sqlTexts = calls.map(([first]) =>
      typeof first === 'string' ? first : (first.strings?.join('?') ?? ''),
    );
    const sapPoQueries = sqlTexts.filter(
      (t) =>
        t.includes('FROM sap_purchase_orders') && t.includes('sum(doc_total)'),
    );
    expect(sapPoQueries.length).toBe(2);
    for (const q of sapPoQueries) {
      expect(q).toContain('maximo_ponum IS NOT NULL AND EXISTS');
      expect(q).toContain('doc_date >=');
    }
  });

  it('acepta la bandera de sync como string (sin Joi en tests)', async () => {
    const { service, queryRaw } = makeService('true');
    queryRaw.mockResolvedValue([]);
    const summary = await service.getSummary();
    expect(summary.fuentes.sap_sync_enabled).toBe(true);
    expect(summary.solicitudes.total).toBe(0);
    expect(summary.ordenes.monto_por_moneda).toEqual([]);
    expect(summary.dias_gestion.sap_ordenes).toBeNull();
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
        { clas: 'OPEX', currency: 'MXN', docs: 3, total: '100' },
      ]);
    const kpis = await service.getOrdersKpis(null);
    expect(kpis.ahorro.disponible).toBe(false);
    expect(kpis.ahorro.por_moneda).toEqual([]);
    expect(kpis.clasificacion.disponible).toBe(true);
    expect(kpis.clasificacion.opex.documentos).toBe(43);
    expect(kpis.clasificacion.opex.por_moneda).toEqual([
      { currency: 'MXN', total: 1334.5, count: 43 },
    ]);
    expect(kpis.clasificacion.capex.por_fuente.sap.por_moneda).toEqual([
      { currency: 'USD', total: 99, count: 1 },
    ]);
  });
});
