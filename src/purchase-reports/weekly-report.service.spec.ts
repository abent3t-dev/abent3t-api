import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { SapRecordsService } from '../sap-records/sap-records.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { PurchaseReportsService } from './purchase-reports.service';
import {
  SAP_PO_HEADERS,
  SAP_PR_HEADERS,
  WeeklyReportService,
} from './weekly-report.service';
import {
  SAP_PO_EXPORT_COLUMNS,
  SAP_PR_EXPORT_COLUMNS,
} from '../sap-records/sap-records.export';
import { TABLERO_MONTO_BASE } from '../common/sql/erp-views.sql';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import {
  buildVendorXref,
  effectiveMaximoVendor,
} from '../erp-vendors/maximo-vendor-xref';
import type { AvanceSemanalService } from './avance-semanal/avance-semanal.service';
import {
  type AvanceData,
  type AvancePage,
  buildAvancePage,
} from './avance-semanal/avance-semanal.engine';
import {
  AVANCE_OPCIONES,
  AVANCE_REGLAS,
} from './avance-semanal/avance-semanal.reglas';

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
    // K6: con el subtotal sin IVA; las 2 de MXN sin subtotal
    ordenes: {
      total: 3,
      monto_por_moneda: [
        {
          currency: 'MXN',
          total: 1000.5,
          count: 2,
          subtotal: 0,
          sin_subtotal: 2,
        },
        {
          currency: 'USD',
          total: 22620,
          count: 1,
          subtotal: 19500,
          sin_subtotal: 0,
        },
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

function makeService(ordenesAvance?: AvanceData['ordenes']) {
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
      // K4.5: ya sin la ventana de folios de las PR de Maximo
      .mockResolvedValueOnce([
        {
          ponum: 'PO104851',
          description: 'O&M Staff Fee Naes MXN septiembre',
          status: 'APPR1',
          vendor_id: 'P0000440',
          vendor_name: 'ASOCIACION MEXICANA DE ENERGIA',
          total_cost: '4300000',
          subtotal: '3706896.55', // K6: Σ LINECOST
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
      // K4.5: solicitudes Maximo = PR creadas en el periodo, una por PR
      .mockResolvedValueOnce([
        {
          prnum: 'PR990002',
          contractnum: null,
          pr_status: 'APPR',
          status: 'APPR',
          has_contract: false,
          con_oc: false,
          pendiente: true,
          vendor_name: null,
          contract_value: null,
          currency: null,
          requested_by: 'USR001',
          pr_issue_date: new Date('2026-09-14T15:00:00Z'),
          pr_approved_at: new Date('2026-09-15T09:00:00Z'),
        },
        {
          prnum: 'PR990006',
          contractnum: '9906',
          pr_status: 'CLOSE',
          status: 'APPR',
          has_contract: true,
          con_oc: false,
          pendiente: false,
          vendor_name: 'PROVEEDOR DEMO',
          contract_value: '96000',
          currency: 'MXN',
          requested_by: 'USR030',
          pr_issue_date: new Date('2026-09-16T14:00:00Z'),
          pr_approved_at: null,
        },
      ])
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
  // H1: datos del avance semanal (una solicitud de SAP cerrada en la semana);
  // K5: una PR de Maximo cancelada (CAN) y otra abierta
  const avanceData: AvanceData = {
    gestiones: [
      {
        sistema: 'sap',
        folio: '324',
        recibida: new Date('2026-09-14T00:00:00Z'),
        fecha_origen: 'documento',
        inicio_dias: new Date('2026-09-14T00:00:00Z'),
        primera_oc: new Date('2026-09-18T00:00:00Z'),
        cierre_sin_oc: null,
        cancelada: null,
        de_contrato: false,
      },
      {
        sistema: 'maximo',
        folio: 'PR990003',
        recibida: new Date('2026-08-21T09:10:00Z'),
        fecha_origen: 'aprobacion',
        inicio_dias: new Date('2026-08-21T09:10:00Z'),
        primera_oc: null,
        cierre_sin_oc: null,
        cancelada: new Date('2026-08-28T16:40:00Z'),
        de_contrato: false,
      },
      {
        sistema: 'maximo',
        folio: 'PR990002',
        recibida: new Date('2026-09-15T09:00:00Z'),
        fecha_origen: 'aprobacion',
        inicio_dias: new Date('2026-09-15T09:00:00Z'),
        primera_oc: null,
        cierre_sin_oc: null,
        cancelada: null,
        de_contrato: false,
      },
    ],
    ordenes: ordenesAvance ?? [
      {
        sistema: 'sap',
        fecha: new Date('2026-09-18T00:00:00Z'),
        moneda: 'MXN',
        monto: 1500.5,
        subtotal: 1293.53,
        contada_en_maximo: false,
      },
    ],
    maximo_no_recibidas: [],
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
  return { service, reports, sap, prisma };
}

async function readBook(buffer: Buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  return book;
}

describe('WeeklyReportService', () => {
  it('K6.7: cada encabezado de SAP_PO_HEADERS / SAP_PR_HEADERS existe en las columnas del export (pick por texto)', () => {
    const po = SAP_PO_EXPORT_COLUMNS.map((c) => c.header);
    const pr = SAP_PR_EXPORT_COLUMNS.map((c) => c.header);
    for (const h of SAP_PO_HEADERS) expect(po).toContain(h);
    for (const h of SAP_PR_HEADERS) expect(pr).toContain(h);
    // "Monto" no se renombra y el subtotal va en las dos listas
    expect(SAP_PO_HEADERS).toContain('Monto');
    expect(SAP_PO_HEADERS).toContain('Subtotal (sin IVA)');
    expect(po).toContain('Subtotal (sin IVA)');
  });

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
    const { service, reports, sap, prisma } = makeService();
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
    // K6.7: renglón "… sin IVA" junto al de la base del tablero; si ninguna
    // OC de la moneda tiene subtotal, "Sin datos" (no 0)
    if (TABLERO_MONTO_BASE === 'con_iva') {
      expect(
        rows.get('Monto de OC creadas (USD), sin IVA')?.slice(0, 2),
      ).toEqual([19500, 19500]);
      expect(
        rows.get('Monto de OC creadas (MXN), sin IVA')?.slice(0, 2),
      ).toEqual(['Sin datos', 'Sin datos']);
    }
    expect(rows.get('Monto de OC creadas (USD)')?.[2]).toContain('IVA');
    // sin base → "Sin datos", nunca 0
    expect(rows.get('Días de gestión SAP (promedio)')?.slice(0, 2)).toEqual([
      2.6,
      'Sin datos',
    ]);
    // foto al día de hoy: sin columna anterior
    const saldo = rows.get('Saldo por recibir de OC SAP abiertas (USD)');
    expect(saldo?.[0]).toBe(5220);
    expect(saldo?.[1]).toBeUndefined();
    // K6.9: el saldo se queda con IVA y lo dice
    expect(saldo?.[2]).toContain('con IVA');

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
    // L3: con las palabras del cliente ("Autorización n")
    expect(po[header.indexOf('Estatus')]).toBe('Autorización 1 (APPR1)');
    // K6.7: "Monto" (TOTALCOST, con IVA) y junto el subtotal sin IVA
    expect(header.indexOf('Subtotal (sin IVA)')).toBe(
      header.indexOf('Monto') + 1,
    );
    expect(po[header.indexOf('Monto')]).toBe(4300000);
    expect(po[header.indexOf('Subtotal (sin IVA)')]).toBe(3706896.55);
    // OC SAP: el encabezado nuevo llega a la hoja (se elige por su texto)
    const sapHeader = (
      book.getWorksheet('OC SAP')!.getRow(1).values as unknown[]
    ).map(String);
    expect(sapHeader).toContain('Monto');
    expect(sapHeader.indexOf('Subtotal (sin IVA)')).toBe(
      sapHeader.indexOf('Monto') + 1,
    );

    // K4.5: Solicitudes Maximo con el estatus DE LA PR y "pendiente" =
    // aprobada (APPR) sin OC ni contrato; el contrato APPR con la PR en
    // CLOSE no es pendiente
    const prSheet = book.getWorksheet('Solicitudes Maximo')!;
    const prHeader = (prSheet.getRow(1).values as unknown[]).map(String);
    const appr = prSheet.getRow(2).values as unknown[];
    const conContrato = prSheet.getRow(3).values as unknown[];
    // K7: el estatus de la PR usa su propio mapa; el del contrato, el de OC
    expect(appr[prHeader.indexOf('Estatus PR')]).toBe(
      'Aprobada: llegó a Compras (APPR)',
    );
    expect(appr[prHeader.indexOf('Pendiente de gestionar')]).toBe(
      'Sí (aprobada, sin OC ni contrato)',
    );
    expect(appr[prHeader.indexOf('Estatus contrato')]).toBeUndefined();
    expect(appr[prHeader.indexOf('Fecha PR (ISSUEDATE)')]).toEqual(
      new Date('2026-09-14T15:00:00Z'),
    );
    expect(conContrato[prHeader.indexOf('Estatus PR')]).toBe('Cerrada (CLOSE)');
    expect(conContrato[prHeader.indexOf('Estatus contrato')]).toBe(
      'Aprobada (APPR)',
    );
    expect(conContrato[prHeader.indexOf('Pendiente de gestionar')]).toBe('No');
    const nota = book.getWorksheet('Nota')!;
    const notas: string[] = [];
    nota.eachRow((row) => notas.push(row.getCell(1).text));
    expect(
      notas.some((n) => n.includes('aprobadas (APPR) sin OC ni contrato')),
    ).toBe(true);
    // la consulta: vista por PR, por ISSUEDATE del periodo, sin folio
    const prQuery = (
      prisma.$queryRaw.mock.calls as unknown as Array<
        [{ sql: string; values: unknown[] }]
      >
    )
      .map(([q]) => q)
      .find((q) => q.sql.includes('AS pendiente'))!;
    const prText = prQuery.sql.replace(/\s+/g, ' ');
    expect(prText).toContain('DISTINCT ON (prnum)');
    expect(prText).toContain('p.pr_issue_date BETWEEN ? AND ?');
    expect(prText).toContain("p.pr_status = 'APPR' AND NOT p.de_contrato");
    expect(prText).not.toContain('regexp_replace');
    expect(prQuery.values).toEqual([
      new Date('2026-09-14T00:00:00Z'),
      new Date('2026-09-20T23:59:59.999Z'),
    ]);

    const approvals = book.getWorksheet('Autorizaciones SAP')!;
    // K6.9: las autorizaciones (borradores, sin líneas) se quedan con IVA
    expect((approvals.getRow(1).values as unknown[]).map(String)).toContain(
      'Monto (con IVA)',
    );
    expect(
      notas.some((n) =>
        n.includes('"Subtotal (sin IVA)" = suma de las líneas'),
      ),
    ).toBe(true);
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
    // K5.6: canceladas y abiertas con dato en las dos fuentes; sin "Sin OC"
    expect(maximo.get('Gestiones recibidas en 2026')).toBe(2);
    expect(maximo.get('Canceladas de las recibidas en 2026')).toBe(1);
    expect(maximo.get('Abiertas de las recibidas en 2026')).toBe(1);
    // O1: días hábiles (7.3 naturales: del viernes 21-ago 03:10 al viernes
    // 28-ago 10:40 de México)
    expect(maximo.get('Días hábiles de cancelación 2026 (promedio)')).toBe(5.3);
    expect(sapBlock.get('Fuente')).toBe('SAP');
    expect(sapBlock.get('Gestiones recibidas en 2026')).toBe(1);
    expect(sapBlock.get('Cerradas en la semana')).toBe(1);
    expect(sapBlock.get('Días hábiles de cierre 2026 (promedio)')).toBe(4);
    expect(sapBlock.get('Canceladas de las recibidas en 2026')).toBe(0);
    expect(sapBlock.has('Abiertas de las recibidas en 2026')).toBe(true);
    for (const b of [maximo, sapBlock]) {
      expect(b.has('Sin OC de las recibidas en 2026')).toBe(false);
      expect([...b.values()]).not.toContain('No disponible');
    }
    // K5.6: montos en la base de AVANCE_MONTO_BASE (O1: con IVA) y el otro
    // valor
    expect(sapBlock.get('Monto adjudicado Septiembre 2026 (MXN)')).toBe(1500.5);
    expect(sapBlock.get('Monto adjudicado total 2026 (MXN)')).toBe(1500.5);
    expect(sapBlock.get('Monto adjudicado total 2026 (MXN), sin IVA')).toBe(
      1293.53,
    );
  });

  it('H9: un mes con OC sin subtotal sale "No disponible" en la base sin IVA; un mes sin OC sigue en 0', async () => {
    const oc = (
      fecha: string,
      monto: number,
      subtotal: number | null,
    ): AvanceData['ordenes'][number] => ({
      sistema: 'sap',
      fecha: new Date(`${fecha}T00:00:00Z`),
      moneda: 'MXN',
      monto,
      subtotal,
      contada_en_maximo: false,
    });
    const ordenes = [
      oc('2026-07-10', 116, 100),
      // agosto: solo OC sin subtotal (sin líneas o alguna sin importe)
      oc('2026-08-10', 58, null),
      oc('2026-08-11', 29, null),
      // septiembre: una con subtotal y otra sin él
      oc('2026-09-15', 232, 200),
      oc('2026-09-16', 11.6, null),
    ];
    const { service } = makeService(ordenes);
    const { buffer } = await service.buildWorkbook({
      from: '2026-09-14',
      to: '2026-09-20',
    });
    const book = await readBook(buffer);
    const libro = new Map<string, { valor: unknown; nota: unknown }>();
    let enSap = false;
    book.getWorksheet('Avance semanal')!.eachRow((row, n) => {
      if (n === 1) return;
      const values = row.values as unknown[];
      if (
        typeof values[2] === 'string' &&
        values[2].startsWith('Reporte de avance semanal de')
      ) {
        enSap = values[1] === 'SAP';
        return;
      }
      if (enSap) {
        libro.set(String(values[1]), { valor: values[2], nota: values[3] });
      }
    });
    // O1: el default es con IVA: todos los meses con OC tienen monto
    expect(libro.get('Monto adjudicado Agosto 2026 (MXN)')?.valor).toBe(87);
    expect(libro.get('Monto adjudicado total 2026 (MXN)')?.valor).toBe(446.6);
    expect(libro.get('Monto adjudicado total 2026 (MXN), sin IVA')?.valor).toBe(
      300,
    );
    // H9 con la base sin IVA (la página con esa opción)
    const filas = new Map(
      (
        service as unknown as {
          avanceRows: (
            p: AvancePage,
          ) => Array<{ indicador: string; valor: unknown; nota?: string }>;
        }
      )
        .avanceRows(
          buildAvancePage(
            {
              gestiones: [],
              ordenes,
              maximo_no_recibidas: [],
              sap_desde: null,
            },
            new Date('2026-09-14T00:00:00Z'),
            'sap',
            new Date('2026-09-30T18:00:00Z'),
            { ...AVANCE_OPCIONES, monto_base: 'sin_iva' },
          ),
        )
        .map((r) => [r.indicador, { valor: r.valor, nota: r.nota }]),
    );
    expect(filas.get('Monto adjudicado Julio 2026 (MXN)')?.valor).toBe(100);
    expect(filas.get('Monto adjudicado Agosto 2026 (MXN)')).toEqual({
      valor: 'No disponible',
      nota: '2 OC sin subtotal no suman (no se estiman)',
    });
    expect(filas.get('Monto adjudicado Septiembre 2026 (MXN)')).toEqual({
      valor: 200,
      nota: '1 OC sin subtotal no suma (no se estiman)',
    });
    // un mes sin OC no es "No disponible": no hubo compras
    expect(filas.get('Monto adjudicado Junio 2026 (MXN)')?.valor).toBe(0);
    expect(filas.get('Monto adjudicado total 2026 (MXN)')?.valor).toBe(300);
  });

  it('H3: con días hábiles, los renglones de días de cierre y de cancelación dicen "Días hábiles"', () => {
    const { service } = makeService();
    const filas = (page: AvancePage) =>
      (
        service as unknown as {
          avanceRows: (p: AvancePage) => Array<{ indicador: string }>;
        }
      )
        .avanceRows(page)
        .map((r) => r.indicador);
    const data: AvanceData = {
      gestiones: [],
      ordenes: [],
      maximo_no_recibidas: [],
      sap_desde: null,
    };
    const lunes = new Date('2026-09-21T00:00:00Z');
    const now = new Date('2026-09-30T18:00:00Z');
    const habiles = filas(
      buildAvancePage(data, lunes, 'maximo', now, {
        ...AVANCE_OPCIONES,
        reglas: { ...AVANCE_REGLAS, dias_tipo: 'habiles' },
      }),
    );
    expect(habiles).toContain('Días hábiles de cierre 2026 (promedio)');
    expect(habiles).toContain(
      'Días hábiles de cierre, semana al 25 de septiembre (promedio)',
    );
    expect(habiles).toContain('Días hábiles de cancelación 2026 (promedio)');
    expect(habiles).not.toContain('Días de cierre 2026 (promedio)');
    // O1: el default ya es hábiles; con naturales, "Días"
    expect(filas(buildAvancePage(data, lunes, 'maximo', now))).toContain(
      'Días hábiles de cierre 2026 (promedio)',
    );
    const naturales = filas(
      buildAvancePage(data, lunes, 'maximo', now, {
        ...AVANCE_OPCIONES,
        reglas: { ...AVANCE_REGLAS, dias_tipo: 'naturales' },
      }),
    );
    expect(naturales).toContain('Días de cierre 2026 (promedio)');
    expect(naturales).toContain('Días de cancelación 2026 (promedio)');
  });

  it('O1: en el bloque de Maximo, las OC de contrato que no suman y las monedas pasadas a pesos', () => {
    const { service } = makeService();
    type Fila = { indicador: string; valor: unknown; nota?: string };
    const filas = (page: AvancePage) =>
      new Map(
        (service as unknown as { avanceRows: (p: AvancePage) => Fila[] })
          .avanceRows(page)
          .map((r) => [r.indicador, r]),
      );
    const oc = (
      fecha: string,
      moneda: string,
      monto: number,
      extra: Partial<AvanceData['ordenes'][number]> = {},
    ): AvanceData['ordenes'][number] => ({
      sistema: 'maximo',
      fecha: new Date(fecha),
      moneda,
      monto,
      subtotal: Math.round((monto / 1.16) * 100) / 100,
      contada_en_maximo: false,
      ...extra,
    });
    const data: AvanceData = {
      gestiones: [],
      ordenes: [
        oc('2026-09-10T18:00:00Z', 'MXN', 1160),
        oc('2026-09-10T18:00:00Z', 'MXN', 5800, { de_contrato: true }),
        oc('2026-09-10T18:00:00Z', 'USD', 116, { tc_usd: 1 }),
      ],
      maximo_no_recibidas: [],
      sap_desde: null,
      tipos_cambio: {
        maximo_dia: [{ dia: '2026-09-10', mxn_por_usd: 17.5 }],
        sap_mes: {},
      },
    };
    const lunes = new Date('2026-09-21T00:00:00Z');
    const now = new Date('2026-09-30T18:00:00Z');
    const maximo = filas(buildAvancePage(data, lunes, 'maximo', now));
    expect(maximo.get('Monto adjudicado total 2026 (MXN)')).toMatchObject({
      valor: 3190,
      nota: 'OC no canceladas sin las de contrato, con IVA, por mes de la OC; USD y EUR en pesos',
    });
    expect(maximo.get('OC de contrato 2026 (no suman)')).toMatchObject({
      valor: 1,
      nota: 'MXN 5,800.00 con IVA; CONTRACTREFNUM en su registro de Maximo (no pasan por RQ)',
    });
    expect(maximo.get('OC en USD pasadas a pesos 2026')).toMatchObject({
      valor: 1,
      nota: 'USD 116.00 con IVA = MXN 2,030.00 (tipo de Maximo del día; sin él, el de referencia de SAP del mes)',
    });
    // la página de SAP no lleva esos renglones
    const sapPage = filas(buildAvancePage(data, lunes, 'sap', now));
    expect(sapPage.has('OC de contrato 2026 (no suman)')).toBe(false);
  });

  it('L2: con el default el Excel no cambia; si la página trae grupos (la constante pasa a contrato), "Atendidas de {año}" los usa con sus nombres', () => {
    const { service } = makeService();
    type Fila = { indicador: string; valor: unknown; nota?: string };
    const filas = (page: AvancePage) =>
      (
        service as unknown as {
          avanceRows: (p: AvancePage) => Fila[];
        }
      ).avanceRows(page);
    const recibida = new Date('2026-09-01T15:00:00Z');
    const pr = (
      folio: string,
      o: Partial<AvanceData['gestiones'][number]>,
    ): AvanceData['gestiones'][number] => ({
      sistema: 'maximo',
      folio,
      recibida,
      fecha_origen: 'aprobacion',
      inicio_dias: recibida,
      primera_oc: null,
      cierre_sin_oc: null,
      cancelada: null,
      de_contrato: false,
      ...o,
    });
    const data: AvanceData = {
      gestiones: [
        pr('PR1', {
          primera_oc: new Date('2026-09-02T15:00:00Z'),
          de_contrato: true,
        }),
        pr('PR2', { cancelada: new Date('2026-09-03T15:00:00Z') }),
        pr('PR3', { primera_oc: new Date('2026-09-08T15:00:00Z') }),
        pr('PR4', {}),
      ],
      ordenes: [],
      maximo_no_recibidas: [],
      sap_desde: null,
    };
    const lunes = new Date('2026-09-21T00:00:00Z');
    const now = new Date('2026-09-30T18:00:00Z');
    // default (AVANCE_GRUPOS_MAXIMO = 'estandar'): el renglón de siempre
    const estandar = filas(buildAvancePage(data, lunes, 'maximo', now));
    const atendidas = (lista: Fila[]) =>
      lista.find((f) => f.indicador === 'Atendidas de 2026');
    expect(atendidas(estandar)).toEqual({
      indicador: 'Atendidas de 2026',
      valor: 3,
      nota: '75% · 2 cerradas · 1 canceladas · 1 abiertas',
    });
    // con grupos: los cuatro, con los nombres del PDF y del JSON
    const conGrupos = buildAvancePage(
      data,
      lunes,
      'maximo',
      now,
      AVANCE_OPCIONES,
      'contrato',
    );
    expect(conGrupos.grupos?.modo).toBe('contrato');
    const grupos = filas(conGrupos);
    expect(atendidas(grupos)).toEqual({
      indicador: 'Atendidas de 2026',
      valor: 3,
      nota: '75% · 1 cerradas sin contrato · 1 de contrato (OC automática) · 1 canceladas en Maximo · 1 abiertas',
    });
    // los demás renglones (indicadores, valores y notas) no cambian
    const resto = (lista: Fila[]) =>
      lista.filter((f) => !f.indicador.startsWith('Atendidas de '));
    expect(resto(grupos)).toEqual(resto(estandar));
    expect(grupos.map((f) => [f.indicador, f.valor])).toEqual(
      estandar.map((f) => [f.indicador, f.valor]),
    );
  });
});
