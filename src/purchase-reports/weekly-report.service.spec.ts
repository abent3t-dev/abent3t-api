import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { SapRecordsService } from '../sap-records/sap-records.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { PurchaseReportsService } from './purchase-reports.service';
import { WeeklyReportService } from './weekly-report.service';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import {
  buildVendorXref,
  effectiveMaximoVendor,
} from '../erp-vendors/maximo-vendor-xref';
import type { AvanceSemanalService } from './avance-semanal/avance-semanal.service';
import type { AvanceData } from './avance-semanal/avance-semanal.engine';

/**
 * Reporte semanal de Compras (2026-09-23): periodo anterior de la misma
 * duración, hojas del libro y reglas de siempre (montos por moneda, sin
 * dato ≠ 0, indicadores "al día de hoy" sin columna anterior).
 */

const gestion = (dias: number | null) => ({
  promedio_dias: dias,
  mediana_dias: dias,
  total: dias === null ? 0 : 5,
});

const resumen = (creadas: number, dias: number | null) => ({
  todas_las_fuentes: {
    solicitudes: {
      creadas,
      pendientes: 27,
      por_fuente: {
        sap: { creadas, pendientes: 27 },
        maximo: { creadas: 0, pendientes: null },
        abent: { creadas: 0, pendientes: 0 },
      },
      pendientes_periodo: { desde: '2025-09-28', hasta: null },
    },
    dias_gestion: { sap: gestion(dias), maximo: gestion(null), abent: null },
    ordenes: {
      total: 3,
      monto_por_moneda: [
        { currency: 'MXN', total: 1000.5, count: 2 },
        { currency: 'USD', total: 22620, count: 1 },
      ],
      por_fuente: { sap: 3, maximo: 0, abent: 0 },
    },
    contratos_por_vencer_30_dias: {
      total: 3,
      por_fuente: { abent: 0, maximo: 3 },
    },
  },
  entregas: { pendientes: 182, vencidas: 952 },
  proveedores: { bloqueados: 0 },
});

function makeService() {
  const reports = {
    resolvePeriod: jest.fn((dto: { from: string; to: string }) => ({
      from: new Date(`${dto.from}T00:00:00Z`),
      to: new Date(`${dto.to}T23:59:59.999Z`),
    })),
    getResumen: jest
      .fn()
      .mockResolvedValueOnce(resumen(22, 2.6))
      .mockResolvedValueOnce(resumen(15, null)),
    getTiemposAprobacion: jest.fn().mockResolvedValue({
      sap: {
        por_aprobador: [{ aprobador: 'Escandón', promedio_dias: 6, total: 9 }],
        pendientes: { total: 5 },
        pendientes_por_aprobador: [
          {
            aprobador: 'Escandón',
            pendientes: 5,
            dias_esperando_max: 14,
            dias_esperando_promedio: 8,
          },
        ],
      },
      maximo_pendientes: { total: 2 },
    }),
  };
  const sap = {
    listAllForExport: jest
      .fn()
      .mockResolvedValue({ rows: [], truncated: false }),
  };
  const prisma = {
    $queryRaw: jest
      .fn()
      // G3: ventana de folios de las PR de Maximo del periodo
      .mockResolvedValueOnce([{ lower: BigInt(104000), upper: null }])
      .mockResolvedValueOnce([
        {
          ponum: 'PO104851',
          description: 'O&M Staff Fee Naes MXN septiembre',
          status: 'APPR1',
          vendor_id: 'P0000440',
          vendor_name: 'ASOCIACION MEXICANA DE ENERGIA',
          total_cost: '4300000',
          currency: 'MXN',
          requested_by: null,
          purchase_agent: null,
          purchase_agent_name: null,
          created_by: null,
          department: null,
          created_at_source: new Date('2026-09-15T00:00:00Z'),
          approved_at: null,
          approved_by: null,
        },
      ]) // OC Maximo
      .mockResolvedValueOnce([]) // solicitudes Maximo
      .mockResolvedValueOnce([
        {
          object_type: '22',
          doc_num: 6344,
          card_name: 'GRUPO GNSYS',
          doc_total: '10705.06',
          currency: 'MXN',
          requester_name: null,
          originator_name: 'Comprador Uno',
          current_stage: 2,
          current_stage_name: 'Dirección',
          creation_date: new Date('2026-09-09T00:00:00Z'),
          dias: 14,
          approvers: [
            { stage_code: 1, user_name: 'Jefe', status: 'ardApproved' },
            { stage_code: 2, user_name: 'Escandón', status: 'ardPending' },
          ],
        },
      ])
      .mockResolvedValueOnce([{ currency: 'USD', saldo: '5220', count: 1 }]),
  };
  // G1: P0000440 de Maximo es NAES en SAP (cruce por sus OC migradas)
  const xref = buildVendorXref(
    ['PO1', 'PO2'].map((ponum) => ({
      ponum,
      vendor_id: 'P0000440',
      vendor_name: 'ASOCIACION MEXICANA DE ENERGIA',
      card_code: 'P0000219',
      card_name: 'NAES ENERGIA S DE RL DE CV',
    })),
    new Map(),
  );
  const vendors = {
    resolve: jest.fn(
      (
        rows: Array<{
          ponum: string;
          vendor_id: string | null;
          vendor_name: string | null;
        }>,
      ) =>
        Promise.resolve(
          rows.map((r) => ({ ...r, supplier: effectiveMaximoVendor(r, xref) })),
        ),
    ),
  };
  // H1: datos del avance semanal (una solicitud de SAP cerrada en la semana)
  const avanceData: AvanceData = {
    gestiones: [
      {
        sistema: 'sap',
        folio: '324',
        recibida: new Date('2026-09-14T00:00:00Z'),
        fecha_origen: 'exacta',
        primera_oc: new Date('2026-09-18T00:00:00Z'),
        cierre_sin_oc: null,
        cancelada: null,
      },
    ],
    ordenes: [
      {
        sistema: 'sap',
        fecha: new Date('2026-09-18T00:00:00Z'),
        moneda: 'MXN',
        monto: 1500.5,
        contada_en_maximo: false,
      },
    ],
    maximo_sin_fecha: 0,
    sap_desde: new Date('2026-01-12T00:00:00Z'),
  };
  const avance = { loadData: jest.fn().mockResolvedValue(avanceData) };
  const service = new WeeklyReportService(
    prisma as unknown as PrismaService,
    reports as unknown as PurchaseReportsService,
    sap as unknown as SapRecordsService,
    {
      resolveMany: jest.fn().mockResolvedValue(new Map<string, string>()),
    } as unknown as ErpAliasesService,
    vendors as unknown as MaximoVendorXrefService,
    avance as unknown as AvanceSemanalService,
  );
  return { service, reports, sap };
}

async function readBook(buffer: Buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  return book;
}

describe('WeeklyReportService', () => {
  it('periodo anterior = misma duración justo antes', () => {
    const { service } = makeService();
    expect(service.previousPeriod('2026-09-14', '2026-09-20')).toEqual({
      from: '2026-09-07',
      to: '2026-09-13',
    });
    expect(service.previousPeriod('2026-09-01', '2026-09-30')).toEqual({
      from: '2026-08-02',
      to: '2026-08-31',
    });
  });

  it('libro con resumen comparado, detalle y autorizaciones', async () => {
    const { service, reports, sap } = makeService();
    const { buffer, filename } = await service.buildWorkbook({
      from: '2026-09-14',
      to: '2026-09-20',
    });
    expect(filename).toBe('reporte_compras_2026-09-14_2026-09-20.xlsx');
    expect(reports.getResumen).toHaveBeenNthCalledWith(2, {
      from: '2026-09-07',
      to: '2026-09-13',
    });
    expect(sap.listAllForExport).toHaveBeenCalledWith('purchase_orders', {
      from: '2026-09-14',
      to: '2026-09-20',
    });

    const book = await readBook(buffer);
    expect(book.worksheets.map((w) => w.name)).toEqual([
      'Resumen',
      'Avance semanal',
      'OC SAP',
      'Solicitudes SAP',
      'OC Maximo',
      'Solicitudes Maximo',
      'Autorizaciones SAP',
      'Pendientes por aprobador',
      'Nota',
    ]);

    const summary = book.getWorksheet('Resumen')!;
    const rows = new Map<string, unknown[]>();
    summary.eachRow((row) => {
      const values = row.values as unknown[];
      rows.set(String(values[1]), values.slice(2));
    });
    expect(summary.getRow(1).getCell(2).value).toBe(
      'Periodo 14/09/2026 al 20/09/2026',
    );
    expect(rows.get('Solicitudes creadas')?.slice(0, 2)).toEqual([22, 15]);
    // montos por moneda, nunca sumados
    expect(rows.get('Monto de OC creadas (USD)')?.slice(0, 2)).toEqual([
      22620, 22620,
    ]);
    // sin base → "Sin datos", nunca 0
    expect(rows.get('Días de gestión SAP (promedio)')?.slice(0, 2)).toEqual([
      2.6,
      'Sin datos',
    ]);
    // foto al día de hoy: sin columna anterior
    const saldo = rows.get('Saldo por recibir de OC SAP abiertas (USD)');
    expect(saldo?.[0]).toBe(5220);
    expect(saldo?.[1]).toBeUndefined();

    // G2: mediana junto al promedio; G3: pendientes = solicitudes sin OC
    expect(rows.get('Días de gestión SAP (mediana)')?.slice(0, 2)).toEqual([
      2.6,
      'Sin datos',
    ]);
    expect(rows.get('Pendientes de gestionar (solicitudes sin OC)')?.[0]).toBe(
      27,
    );

    // G1 y G7: proveedor efectivo y estatus con etiqueta y código
    const maximoSheet = book.getWorksheet('OC Maximo')!;
    const header = (maximoSheet.getRow(1).values as unknown[]).map(String);
    const po = maximoSheet.getRow(2).values as unknown[];
    expect(po[header.indexOf('Proveedor')]).toBe('NAES ENERGIA S DE RL DE CV');
    expect(po[header.indexOf('Código proveedor')]).toBe('P0000219');
    expect(po[header.indexOf('Proveedor en Maximo')]).toBe(
      'ASOCIACION MEXICANA DE ENERGIA',
    );
    expect(po[header.indexOf('Estatus')]).toBe(
      'En aprobación · nivel 1 aprobado (APPR1)',
    );

    const approvals = book.getWorksheet('Autorizaciones SAP')!;
    const first = approvals.getRow(2).values as unknown[];
    expect(first[1]).toBe('OC');
    expect(first[6]).toBe('Comprador Uno');
    expect(first[8]).toBe('Escandón'); // solo la etapa actual

    const byApprover = book.getWorksheet('Pendientes por aprobador')!;
    expect(byApprover.getRow(2).getCell(5).value).toBe('Retrasado');

    // H1: la semana del periodo con los mismos KPIs que el PDF; I3: un
    // bloque de Maximo y uno de SAP (homologados), no el combinado
    const blocks = new Map<string, Map<string, unknown>>();
    let block: Map<string, unknown> | null = null;
    book.getWorksheet('Avance semanal')!.eachRow((row, n) => {
      if (n === 1) return;
      const values = row.values as unknown[];
      const valor = values[2];
      if (
        typeof valor === 'string' &&
        valor.startsWith('Reporte de avance semanal de')
      ) {
        block = new Map();
        blocks.set(String(values[1]), block);
        expect(row.font?.bold).toBe(true);
        return;
      }
      block?.set(String(values[1]), valor);
    });
    expect([...blocks.keys()]).toEqual(['Maximo', 'SAP']);
    const maximo = blocks.get('Maximo')!;
    const sapBlock = blocks.get('SAP')!;
    for (const b of [maximo, sapBlock]) {
      expect(b.get('Semana')).toBe('Semana del 14 al 18 de septiembre de 2026');
    }
    expect(maximo.get('Fuente')).toBe('Maximo');
    expect(maximo.get('Gestiones recibidas en 2026')).toBe(0);
    expect(maximo.get('Canceladas de las recibidas en 2026')).toBe(
      'No disponible',
    );
    expect(maximo.has('Sin OC de las recibidas en 2026')).toBe(true);
    expect(sapBlock.get('Fuente')).toBe('SAP');
    expect(sapBlock.get('Gestiones recibidas en 2026')).toBe(1);
    expect(sapBlock.get('Cerradas en la semana')).toBe(1);
    expect(sapBlock.get('Días de cierre 2026 (promedio)')).toBe(4);
    expect(sapBlock.get('Monto adjudicado Septiembre 2026 (MXN)')).toBe(1500.5);
    expect(sapBlock.has('Sin OC de las recibidas en 2026')).toBe(false);
    expect(sapBlock.has('Abiertas de las recibidas en 2026')).toBe(true);
  });
});
