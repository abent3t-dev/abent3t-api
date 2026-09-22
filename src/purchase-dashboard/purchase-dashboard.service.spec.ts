/**
 * Sprint 2026-09-22 (A1) — resumen del dashboard con las tres fuentes.
 * Prisma mockeado: se pinza (1) que los montos se agregan POR MONEDA sin
 * mezclar monedas, (2) que los días de gestión salen null cuando no hay
 * base (nunca 0) y (3) que los totales suman las tres fuentes.
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

describe('PurchaseDashboardService.getSummary', () => {
  it('agrega SAP + Maximo + ABENT, montos por moneda y días null sin base', async () => {
    const { service, queryRaw } = makeService();
    queryRaw
      // sapPr count
      .mockResolvedValueOnce([{ total: 309, pendientes: 12 }])
      // sapPrDias
      .mockResolvedValueOnce([{ dias: '8.44' }])
      // sapPo por moneda
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
      // sapPoDias
      .mockResolvedValueOnce([{ dias: '3.06' }]);

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
    expect(summary.por_recibir.total).toBe(752);
    expect(summary.por_recibir.monto_por_moneda).toEqual([
      { currency: 'MXN', total: 110, count: 752 },
    ]);
    // Días: redondeo a 1 decimal; null cuando no hay base (nunca 0)
    expect(summary.dias_gestion).toEqual({
      sap_solicitudes: 8.4,
      sap_ordenes: 3.1,
      maximo_ordenes: null,
      abent_requisiciones: null,
    });
    expect(summary.fuentes).toEqual({
      sap_sync_enabled: true,
      maximo_sync_enabled: false,
    });
    expect(queryRaw).toHaveBeenCalledTimes(13);
  });

  it('acepta la bandera de sync como string (sin Joi en tests)', async () => {
    const { service, queryRaw } = makeService('true');
    queryRaw.mockResolvedValue([]);
    const summary = await service.getSummary();
    expect(summary.fuentes.sap_sync_enabled).toBe(true);
    expect(summary.solicitudes.total).toBe(0);
    expect(summary.ordenes.monto_por_moneda).toEqual([]);
  });
});
