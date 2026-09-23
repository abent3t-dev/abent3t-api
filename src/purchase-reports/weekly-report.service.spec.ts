import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { SapRecordsService } from '../sap-records/sap-records.service';
import { PurchaseReportsService } from './purchase-reports.service';
import { WeeklyReportService } from './weekly-report.service';

/**
 * Reporte semanal de Compras (2026-09-23): periodo anterior de la misma
 * duración, hojas del libro y reglas de siempre (montos por moneda, sin
 * dato ≠ 0, indicadores "al día de hoy" sin columna anterior).
 */

const resumen = (creadas: number, dias: number | null) => ({
  todas_las_fuentes: {
    solicitudes: {
      creadas,
      abiertas: 27,
      por_fuente: {
        sap: { creadas, abiertas: 27 },
        maximo: { creadas: 0, abiertas: 0 },
        abent: { creadas: 0, abiertas: 0 },
      },
    },
    dias_gestion: { sap: dias, maximo: null, abent: null },
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
      .mockResolvedValueOnce([]) // OC Maximo
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
  const service = new WeeklyReportService(
    prisma as unknown as PrismaService,
    reports as unknown as PurchaseReportsService,
    sap as unknown as SapRecordsService,
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

    const approvals = book.getWorksheet('Autorizaciones SAP')!;
    const first = approvals.getRow(2).values as unknown[];
    expect(first[1]).toBe('OC');
    expect(first[6]).toBe('Comprador Uno');
    expect(first[8]).toBe('Escandón'); // solo la etapa actual

    const byApprover = book.getWorksheet('Pendientes por aprobador')!;
    expect(byApprover.getRow(2).getCell(5).value).toBe('Retrasado');
  });
});
