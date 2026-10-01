import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ExpeditingService } from '../expediting/expediting.service';
import { PurchaseCommitteesService } from '../purchase-committees/purchase-committees.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { PurchaseReportsService } from './purchase-reports.service';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import {
  buildVendorXref,
  MaximoVendorXref,
} from '../erp-vendors/maximo-vendor-xref';

/**
 * Fase Reportes. Prisma y services consumidos MOCKEADOS — sin BD/red.
 * Verifica: validación del rango (default 12m, tope 24m), serie mensual con
 * meses vacíos en cero, "sin clasificar" visible, ahorro por FUENTE y por
 * MONEDA (T10) y consumo de las fórmulas existentes sin variantes.
 */

function makeService(
  queryResults: unknown[][] = [],
  xref: MaximoVendorXref = buildVendorXref([], new Map()),
) {
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
      // I6: valor de los vigentes por moneda
      groupBy: jest.fn().mockResolvedValue([
        { currency: 'USD', _sum: { total_amount: '20000.00' } },
        { currency: 'MXN', _sum: { total_amount: '1000000.00' } },
      ]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    suppliers: { count: jest.fn().mockResolvedValue(1) },
    sap_approval_requests: { findMany: jest.fn().mockResolvedValue([]) },
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
  const vendors = { get: jest.fn().mockResolvedValue(xref) };
  const service = new PurchaseReportsService(
    prisma as unknown as PrismaService,
    approvals as unknown as ApprovalsService,
    expediting as unknown as ExpeditingService,
    committees as unknown as PurchaseCommitteesService,
    aliases as unknown as ErpAliasesService,
    vendors as unknown as MaximoVendorXrefService,
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
    // I6: por moneda, nunca sumados (MXN primero)
    expect(resumen.contratos.valor_vigentes_por_moneda).toEqual([
      { currency: 'MXN', total: 1000000 },
      { currency: 'USD', total: 20000 },
    ]);
    expect(resumen.proveedores.bloqueados).toBe(1);
    // Sin staging ERP: los totales de todas las fuentes = los propios
    expect(resumen.todas_las_fuentes.solicitudes.creadas).toBe(4);
    expect(resumen.todas_las_fuentes.dias_gestion.sap.promedio_dias).toBeNull();
    // sin fechas de PR de Maximo no se inventan pendientes
    expect(
      resumen.todas_las_fuentes.solicitudes.por_fuente.maximo.pendientes,
    ).toBeNull();
  });

  it('resumen: suma SAP + Maximo + ABENT; montos de la misma moneda se juntan, monedas distintas no', async () => {
    const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
    const { service } = makeService([
      // G3: ventana de folios del periodo y la de pendientes (12 meses)
      [{ lower: BigInt(104000), upper: null }],
      [{ lower: BigInt(104500), upper: null }],
      // G3: pendientes SAP y Maximo (RQ sin OC)
      [{ pendientes: 27, sin_limite: 30 }],
      [{ pendientes: 1, sin_limite: 50 }],
      [
        {
          sap_rq_creadas: 300,
          maximo_rq_creadas: 4,
          maximo_contratos_por_vencer: 2,
        },
      ],
      [
        { fuente: 'sap', currency: 'MXN', count: 1000, total: '5000.50' },
        { fuente: 'sap', currency: 'USD', count: 10, total: '70' },
        { fuente: 'maximo', currency: 'MXN', count: 5, total: '100' },
      ],
      // G2: OC de SAP del periodo con su solicitud base
      [
        { doc_entry: 1, doc_date: d('2026-03-11'), base_request_entries: [7] },
        { doc_entry: 2, doc_date: d('2026-03-04'), base_request_entries: [7] },
      ],
      // G2: días de gestión de las OC de Maximo del periodo
      [{ dias: null }],
      // fechas de las solicitudes base
      [{ doc_entry: 7, doc_date: d('2026-03-01') }],
    ]);
    const resumen = await service.getResumen({
      from: '2026-01-01',
      to: '2026-06-30',
    });
    const todas = resumen.todas_las_fuentes;
    expect(todas.solicitudes.creadas).toBe(308); // 300 + 4 + 4 propias
    // G3: pendientes = RQ sin OC (27 SAP + 1 Maximo + 4 propias)
    expect(todas.solicitudes.pendientes).toBe(32);
    // G2: SAP (10 + 3) / 2 = 6.5 días; Maximo sin OC con solicitud → null
    expect(todas.dias_gestion).toEqual({
      sap: { promedio_dias: 6.5, mediana_dias: 6.5, total: 2 },
      maximo: { promedio_dias: null, mediana_dias: null, total: 0 },
      abent: 6.5,
    });
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
    const DAY = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * DAY);
    const iso = (d: Date) => d.toISOString();
    const { service, prisma } = makeService([
      [], // maximo po
      // G6: aprobaciones del historial POSTATUS (le llegó con el cambio anterior)
      [
        {
          status: 'APPR1',
          changed_by: 'DAROJE',
          change_date: ago(10),
          prev_date: ago(14),
        },
        {
          status: 'APPR2',
          changed_by: 'MAOG1',
          change_date: ago(8),
          prev_date: ago(10),
        },
        {
          status: 'APPR',
          changed_by: 'GMV1',
          change_date: ago(7),
          prev_date: ago(8),
        },
      ],
      [], // maximo contratos
      [], // sap autorizadas
      [{ total: 9, dias: '4.2' }],
      [{ total: 2, dias_max: 12, dias_promedio: '8.5' }],
    ]);
    // G5: la cola de SAP con sus líneas por etapa
    prisma.sap_approval_requests.findMany.mockResolvedValue([
      {
        code: 1,
        status: 'arsPending',
        current_stage: 2,
        creation_date: ago(20.2),
        approvers: [
          // etapa 1 aprobada hace 6.2 días → a David le llegó entonces
          {
            stage_code: 1,
            user_name: 'Jefe',
            status: 'ardApproved',
            update_date: iso(ago(6.2)),
          },
          {
            stage_code: 2,
            user_name: 'David Rodríguez',
            status: 'ardPending',
            update_date: iso(ago(6.2)),
          },
        ],
      },
      {
        code: 2,
        status: 'arsPending',
        current_stage: 5,
        creation_date: ago(2.5),
        approvers: [
          {
            stage_code: 5,
            user_name: 'David Rodríguez',
            status: 'ardPending',
            update_date: null,
          },
          // etapa futura: todavía no le llega a Uriel
          {
            stage_code: 6,
            user_name: 'Uriel LASES',
            status: 'ardPending',
            update_date: null,
          },
        ],
      },
    ]);
    const tiempos = await service.getTiemposAprobacion();
    // la más antigua cuenta desde que le llegó (6 días), no desde la creación (20)
    expect(tiempos.sap.pendientes_por_aprobador).toEqual([
      {
        aprobador: 'David Rodríguez',
        usuario: 'David Rodríguez',
        pendientes: 2,
        // días completos con él: 6 y 2
        dias_esperando_max: 6,
        dias_esperando_promedio: 4,
      },
    ]);
    // aprobó "Jefe": le llegó con la creación (14 días antes de decidir)
    expect(tiempos.sap.por_aprobador).toEqual([
      { aprobador: 'Jefe', usuario: 'Jefe', promedio_dias: 14, total: 1 },
    ]);
    // G6: aparecen todos los niveles de Maximo (Miguel y Gilberto incluidos)
    expect(
      tiempos.maximo.ordenes_por_aprobador.map((r) => [
        r.usuario,
        r.promedio_dias,
        r.niveles,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['DAROJE', 4, ['Nivel 1']],
        ['MAOG1', 2, ['Nivel 2']],
        ['GMV1', 1, ['Aprobación final']],
      ]),
    );
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

describe('PurchaseReportsService — top de proveedores (G1, 2026-09-28)', () => {
  const ASOCIACION = 'ASOCIACION MEXICANA DE ENERGIA';
  const NAES = 'NAES ENERGIA S DE RL DE CV';
  // Fixture del diagnóstico: la OC de Maximo de P0000440 "ASOCIACION…"
  // migró a SAP a nombre de P0000219 "NAES…"
  const xref = buildVendorXref(
    [
      {
        ponum: 'PO104279',
        vendor_id: 'P0000440',
        vendor_name: ASOCIACION,
        card_code: 'P0000219',
        card_name: 'NAES ENERGIA',
      },
      {
        ponum: 'PO104356',
        vendor_id: 'P0000440',
        vendor_name: ASOCIACION,
        card_code: 'P0000219',
        card_name: NAES,
      },
    ],
    new Map([['P0000219', NAES]]),
  );
  const maximoPos = [
    // migradas (regla a) y una aún sin migrar (regla b)
    {
      ponum: 'PO104279',
      vendor_id: 'P0000440',
      vendor_name: ASOCIACION,
      currency: 'MXN',
      total_cost: '4270000',
    },
    {
      ponum: 'PO104356',
      vendor_id: 'P0000440',
      vendor_name: ASOCIACION,
      currency: 'MXN',
      total_cost: '4650000',
    },
    {
      ponum: 'PO104851',
      vendor_id: 'P0000440',
      vendor_name: ASOCIACION,
      currency: 'MXN',
      total_cost: '4300000',
    },
    {
      ponum: 'PO200001',
      vendor_id: 'P0000500',
      vendor_name: 'LOCAL SA DE CV',
      currency: 'MXN',
      total_cost: '1000',
    },
  ];
  const sapVendors = [
    // SAP contado una vez: la anualidad real de la Asociación y otra de NAES
    {
      card_code: 'P0000440',
      card_name: ASOCIACION,
      currency: 'MXN',
      count: 1,
      monto: '412500',
    },
    {
      card_code: 'P0000219',
      card_name: NAES,
      currency: 'MXN',
      count: 1,
      monto: '100000',
    },
  ];

  it('Maximo muestra NAES (con "en Maximo: ASOCIACION…"); SAP y combinado por código', async () => {
    const { service } = makeService(
      [[], [], [], [], sapVendors, [], [], [], maximoPos],
      xref,
    );
    const report = await service.getErp({
      from: '2026-01-01',
      to: '2026-09-28',
    });

    const [top] = report.maximo.top_proveedores;
    expect(top).toMatchObject({
      key: 'sap:P0000219',
      sistema: 'sap',
      codigo: 'P0000219',
      proveedor: NAES,
      currency: 'MXN',
      count: 3,
      monto: 13220000,
      nota: `en Maximo: ${ASOCIACION} (P0000440)`,
    });
    expect(
      report.maximo.top_proveedores.some((r) => r.proveedor === ASOCIACION),
    ).toBe(false);

    // SAP: con código; la Asociación de SAP sigue siendo la Asociación
    expect(
      report.sap.top_proveedores.map((r) => [r.codigo, r.proveedor]),
    ).toEqual([
      ['P0000440', ASOCIACION],
      ['P0000219', NAES],
    ]);

    // Combinado: NAES junta SAP + Maximo sin duplicar
    const naes = report.combinado.top_proveedores[0];
    expect(naes).toMatchObject({
      key: 'sap:P0000219',
      count: 4,
      monto: 13320000,
      por_fuente: {
        sap: { count: 1, monto: 100000 },
        maximo: { count: 3, monto: 13220000 },
      },
    });
  });
});
