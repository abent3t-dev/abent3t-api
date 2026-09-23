import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ExpeditingService } from '../expediting/expediting.service';
import { PurchaseCommitteesService } from '../purchase-committees/purchase-committees.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
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
    user_roles: {
      findMany: jest.fn().mockResolvedValue([
        {
          role: 'aprobador_nivel_3',
          profiles_user_roles_profile_idToprofiles: {
            full_name: 'Uriel Lases',
            email: 'uriel@abent3t.com',
          },
        },
      ]),
    },
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
  const aliases = {
    resolveMany: jest.fn().mockResolvedValue(new Map<string, string>()),
    displayName: jest.fn((_s: string, code: string | null) =>
      Promise.resolve(code),
    ),
    forProfiles: jest.fn().mockResolvedValue([]),
    byCode: jest.fn().mockResolvedValue(new Map()),
  };
  const service = new PurchaseReportsService(
    prisma as unknown as PrismaService,
    approvals as unknown as ApprovalsService,
    expediting as unknown as ExpeditingService,
    committees as unknown as PurchaseCommitteesService,
    aliases as unknown as ErpAliasesService,
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
    // Sin staging ERP: los totales de todas las fuentes = los propios
    expect(resumen.todas_las_fuentes.solicitudes.creadas).toBe(4);
    expect(resumen.todas_las_fuentes.dias_gestion.sap).toBeNull();
  });

  it('resumen: suma SAP + Maximo + ABENT; montos de la misma moneda se juntan, monedas distintas no', async () => {
    const { service } = makeService([
      [
        {
          sap_rq_creadas: 300,
          sap_rq_abiertas: 27,
          sap_dias: '6.34',
          maximo_rq_creadas: 4,
          maximo_rq_abiertas: 1,
          maximo_dias: null,
          maximo_contratos_por_vencer: 2,
        },
      ],
      [
        { fuente: 'sap', currency: 'MXN', count: 1000, total: '5000.50' },
        { fuente: 'sap', currency: 'USD', count: 10, total: '70' },
        { fuente: 'maximo', currency: 'MXN', count: 5, total: '100' },
      ],
    ]);
    const resumen = await service.getResumen({
      from: '2026-01-01',
      to: '2026-06-30',
    });
    const todas = resumen.todas_las_fuentes;
    expect(todas.solicitudes.creadas).toBe(308); // 300 + 4 + 4 propias
    expect(todas.solicitudes.abiertas).toBe(32);
    expect(todas.dias_gestion).toEqual({ sap: 6.3, maximo: null, abent: 6.5 });
    expect(todas.ordenes.total).toBe(1018); // 1000 + 10 + 5 + 3 propias
    expect(todas.ordenes.monto_por_moneda).toEqual([
      { currency: 'MXN', total: 6000.5, count: 1008 },
      { currency: 'USD', total: 70, count: 10 },
    ]);
    expect(todas.contratos_por_vencer_30_dias).toEqual({
      total: 4,
      por_fuente: { abent: 2, maximo: 2 },
    });
  });

  it('tiempos: pendientes por aprobador en SAP, espera de Maximo y niveles ABENT con su asignación', async () => {
    const { service } = makeService([
      [], // maximo po
      [], // maximo po por aprobador
      [], // maximo contratos
      [], // sap autorizadas
      [], // sap por aprobador
      [{ total: 9, dias: '4.2' }],
      [
        {
          aprobador: 'David Rodríguez',
          pendientes: 3,
          dias_max: 6,
          dias_promedio: '4.33',
        },
        { aprobador: null, pendientes: 1, dias_max: 1, dias_promedio: '1' },
      ],
      [{ total: 2, dias_max: 12, dias_promedio: '8.5' }],
    ]);
    const tiempos = await service.getTiemposAprobacion();
    expect(tiempos.sap.pendientes_por_aprobador).toEqual([
      {
        aprobador: 'David Rodríguez',
        usuario: 'David Rodríguez',
        pendientes: 3,
        dias_esperando_max: 6,
        dias_esperando_promedio: 4.3,
      },
      {
        aprobador: 'Sin nombre en SAP',
        usuario: null,
        pendientes: 1,
        dias_esperando_max: 1,
        dias_esperando_promedio: 1,
      },
    ]);
    expect(tiempos.maximo_pendientes).toEqual({
      total: 2,
      dias_esperando_max: 12,
      dias_esperando_promedio: 8.5,
    });
    expect(tiempos.abent_niveles).toEqual([
      {
        level: 1,
        role: 'aprobador_nivel_1',
        aprobadores: [],
        erp_usuarios: [],
        sap_pendientes: 0,
      },
      {
        level: 2,
        role: 'aprobador_nivel_2',
        aprobadores: [],
        erp_usuarios: [],
        sap_pendientes: 0,
      },
      {
        level: 3,
        role: 'aprobador_nivel_3',
        aprobadores: ['Uriel Lases'],
        erp_usuarios: [],
        sap_pendientes: 0,
      },
      {
        level: 4,
        role: 'director_general',
        aprobadores: [],
        erp_usuarios: [],
        sap_pendientes: 0,
      },
    ]);
  });
});
