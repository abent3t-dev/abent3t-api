import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ExpeditingService } from '../expediting/expediting.service';
import { PurchaseCommitteesService } from '../purchase-committees/purchase-committees.service';
import { PurchaseReportsService } from './purchase-reports.service';

/**
 * Fase Reportes. Prisma y services consumidos MOCKEADOS — sin BD/red.
 * Verifica: validación del rango (default 12m, tope 24m), serie mensual con
 * meses vacíos en cero, "sin clasificar" visible, ahorro por FUENTE y por
 * MONEDA (T10) y consumo de las fórmulas existentes sin variantes.
 */

function makeService(queryResults: unknown[][] = []) {
  let call = 0;
  const prisma = {
    $queryRaw: jest.fn(() => Promise.resolve(queryResults[call++] ?? [])),
    requisitions: {
      count: jest.fn().mockResolvedValue(4),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _avg: { business_days_elapsed: '6.5' } }),
    },
    purchase_orders: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _count: { _all: 3 }, _sum: { amount: '900.00' } }),
    },
    contracts: {
      count: jest.fn().mockResolvedValue(2),
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: 5 },
        _sum: { total_amount: '1000000.00' },
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    suppliers: { count: jest.fn().mockResolvedValue(1) },
  };
  const approvals = {
    getStats: jest.fn().mockResolvedValue({ 1: { level: 1 } }),
  };
  const expediting = {
    getStats: jest.fn().mockResolvedValue({
      counts: {
        sin_fecha: 1,
        en_tiempo: 2,
        en_riesgo: 3,
        retrasada: 4,
        parcial: 0,
        entregada: 5,
      },
      avg_delay_days: 2.5,
      top_delayed_suppliers: [],
    }),
  };
  const committees = {
    dashboardTiempos: jest.fn().mockResolvedValue({ byApprover: [] }),
  };
  const service = new PurchaseReportsService(
    prisma as unknown as PrismaService,
    approvals as unknown as ApprovalsService,
    expediting as unknown as ExpeditingService,
    committees as unknown as PurchaseCommitteesService,
  );
  return { service, prisma, approvals, expediting, committees };
}

describe('PurchaseReportsService — periodo (regla 5)', () => {
  it('default = últimos 12 meses; from > to y rangos > 24 meses se rechazan', () => {
    const { service } = makeService();
    const period = service.resolvePeriod({});
    const months =
      (period.to.getUTCFullYear() - period.from.getUTCFullYear()) * 12 +
      (period.to.getUTCMonth() - period.from.getUTCMonth());
    expect(months).toBe(11); // 12 meses incluyente

    expect(() =>
      service.resolvePeriod({ from: '2026-05-01', to: '2026-01-01' }),
    ).toThrow(BadRequestException);
    expect(() =>
      service.resolvePeriod({ from: '2020-01-01', to: '2026-01-01' }),
    ).toThrow('24 meses');
    expect(() =>
      service.resolvePeriod({ from: '2025-01-01', to: '2026-06-30' }),
    ).not.toThrow();
  });
});

describe('PurchaseReportsService — series y clasificación', () => {
  it('requisiciones: serie mensual zero-filled y "sin_clasificar" en estatus null', async () => {
    const { service } = makeService([
      // creadas: solo febrero tiene datos
      [{ month: new Date(Date.UTC(2026, 1, 1)), count: 3 }],
      // cerradas: solo abril
      [{ month: new Date(Date.UTC(2026, 3, 1)), count: 2 }],
      // por estatus (uno null)
      [
        { status: 'aprobada', count: 2, monto: '100.00' },
        { status: null, count: 1, monto: '50.00' },
      ],
      [],
      [],
    ]);
    const report = await service.getRequisiciones({
      from: '2026-01-01',
      to: '2026-06-30',
    });
    expect(report.serie_mensual).toHaveLength(6);
    expect(report.serie_mensual[0]).toEqual({
      month: '2026-01',
      creadas: 0,
      cerradas: 0,
    });
    expect(report.serie_mensual[1]).toEqual({
      month: '2026-02',
      creadas: 3,
      cerradas: 0,
    });
    expect(report.serie_mensual[3].cerradas).toBe(2);
    expect(report.por_estatus).toContainEqual({
      status: 'sin_clasificar',
      count: 1,
      monto: 50,
    });
  });

  it('ahorro (T10): fuente ABENT no disponible; Maximo por MONEDA + sin_clasificar', async () => {
    const { service } = makeService([
      [
        { currency: 'MXN', total: '27645.00', count: 1 },
        { currency: 'USD', total: '100.50', count: 2 },
      ],
      [{ count: 6 }],
    ]);
    const report = await service.getAhorro({
      from: '2026-01-01',
      to: '2026-06-30',
    });
    expect(report.abent.disponible).toBe(false);
    expect(report.maximo.por_moneda).toEqual([
      { currency: 'MXN', total: 27645, registros: 1 },
      { currency: 'USD', total: 100.5, registros: 2 },
    ]);
    expect(report.maximo.sin_clasificar).toBe(6);
    // Nunca hay un "total combinado" entre fuentes ni monedas
    expect(JSON.stringify(report)).not.toContain('total_combinado');
  });

  it('maximo: estatus null visible como sin_clasificar', async () => {
    const { service } = makeService([
      [
        { status: 'CLOSE', count: 4 },
        { status: 'sin_clasificar', count: 3 },
      ],
      [],
      [{ status: 'APPR', count: 3 }],
      [{ count: 3 }],
    ]);
    const report = await service.getMaximo({
      from: '2026-01-01',
      to: '2026-06-30',
    });
    expect(report.purchase_orders.por_estatus).toContainEqual({
      status: 'sin_clasificar',
      count: 3,
    });
    expect(report.purchase_orders.sin_fecha_aprobacion).toBe(3);
  });
});

describe('PurchaseReportsService — fórmulas existentes (regla 3)', () => {
  it('aprobaciones/entregas/comité consumen los services existentes tal cual', async () => {
    const { service, approvals, expediting, committees } = makeService([[]]);
    const aprobaciones = await service.getAprobaciones();
    expect(approvals.getStats).toHaveBeenCalledTimes(1);
    expect(aprobaciones.fuente).toContain('fórmula existente');

    const entregas = await service.getEntregas();
    expect(expediting.getStats).toHaveBeenCalledTimes(1);
    expect(entregas.stats.counts.retrasada).toBe(4);

    const comite = await service.getComite();
    expect(committees.dashboardTiempos).toHaveBeenCalledTimes(1);
    expect(comite.tiempos).toEqual({ byApprover: [] });
  });

  it('resumen: junta contadores propios + stats de expeditación (Decimal→number)', async () => {
    const { service } = makeService();
    const resumen = await service.getResumen({
      from: '2026-01-01',
      to: '2026-06-30',
    });
    expect(resumen.requisiciones.promedio_dias_gestion).toBe(6.5);
    expect(resumen.ordenes.monto_total).toBe(900);
    expect(resumen.entregas.pendientes).toBe(6); // en_tiempo+en_riesgo+sin_fecha
    expect(resumen.entregas.vencidas).toBe(4);
    expect(resumen.contratos.valor_vigentes).toBe(1000000);
    expect(resumen.proveedores.bloqueados).toBe(1);
  });
});
