import { PrismaService } from '../prisma/prisma.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import {
  buildVendorXref,
  effectiveMaximoVendor,
} from '../erp-vendors/maximo-vendor-xref';
import { ApprovalChainService } from './approval-chain.service';
import { PurchaseReportsService } from './purchase-reports.service';

/**
 * G5/G6 (2026-09-28). Prisma, alias y cruce de proveedores simulados.
 */

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

function makeService(queryResults: unknown[][], sapDocs: unknown[] = []) {
  let call = 0;
  const prisma = {
    $queryRaw: jest.fn(() => Promise.resolve(queryResults[call++] ?? [])),
    sap_approval_requests: { findMany: jest.fn().mockResolvedValue(sapDocs) },
  };
  const reports = {
    resolvePeriod: jest.fn((dto: { from?: string; to?: string }) => ({
      from: new Date(`${dto.from ?? '2026-01-01'}T00:00:00Z`),
      to: new Date(`${dto.to ?? '2026-09-30'}T23:59:59.999Z`),
    })),
  };
  const aliases = {
    resolveMany: jest.fn((_s: string, codes: Array<string | null>) =>
      Promise.resolve(
        new Map(
          codes
            .filter((c): c is string => c === 'MAOG1' || c === 'GMV1')
            .map((c) => [
              c,
              c === 'MAOG1' ? 'Miguel Ángel Ortiz' : 'Gilberto Maltos',
            ]),
        ),
      ),
    ),
  };
  const xref = buildVendorXref([], new Map());
  const vendors = {
    resolve: jest.fn(
      (
        rows: Array<{
          vendor_id: string | null;
          vendor_name: string | null;
          ponum?: string;
        }>,
      ) =>
        Promise.resolve(
          rows.map((r) => ({ ...r, supplier: effectiveMaximoVendor(r, xref) })),
        ),
    ),
  };
  const service = new ApprovalChainService(
    prisma as unknown as PrismaService,
    reports as unknown as PurchaseReportsService,
    aliases as unknown as ErpAliasesService,
    vendors as unknown as MaximoVendorXrefService,
  );
  return { service, prisma };
}

const pendingRow = (ponum: string, status: string, days: number) => ({
  ponum,
  description: `OC ${ponum}`,
  status,
  vendor_id: 'P0000100',
  vendor_name: 'PROVEEDOR SA DE CV',
  total_cost: '1000',
  currency: 'MXN',
  desde: ago(days),
});

describe('ApprovalChainService.getCadenaMaximo (G6)', () => {
  it('OC en aprobación por nivel que esperan, con antigüedad y aprobadores habituales', async () => {
    const { service } = makeService([
      [
        pendingRow('PO1', 'WAPPR', 5.5),
        pendingRow('PO2', 'APPR1', 3.2),
        pendingRow('PO3', 'APPR1', 1.1),
        pendingRow('PO4', 'APPR1REV', 2),
      ],
      [
        { desde: 'WAPPR', usuario: 'DAROJE', veces: 1491 },
        { desde: 'WAPPR', usuario: 'JOFUE', veces: 389 },
        { desde: 'APPR1', usuario: 'TOMB1', veces: 303 },
        { desde: 'APPR1', usuario: 'EURA', veces: 189 },
        { desde: 'APPR1', usuario: 'MAOG1', veces: 90 },
        { desde: 'APPR1', usuario: 'GMV1', veces: 13 },
      ],
    ]);
    const cadena = await service.getCadenaMaximo();
    expect(cadena.total).toBe(4);
    // L3: el nivel que espera dice a quién le toca (su titular)
    expect(
      cadena.por_nivel.map((n) => [n.etiqueta, n.pendientes, n.dias_max]),
    ).toEqual([
      ['Nivel 1 · David Alejandro Rodríguez Ojeda', 1, 5],
      ['Nivel 2 · Miguel Ángel Ortiz García', 2, 3],
      ['Nivel 2 (revisión) · Miguel Ángel Ortiz García', 1, 2],
    ]);
    // los habituales del paso: top 3 de quién aprueba después de ese estatus
    expect(
      cadena.por_nivel[1].aprobadores_habituales.map((h) => [
        h.usuario,
        h.nombre,
      ]),
    ).toEqual([
      ['TOMB1', 'TOMB1'],
      ['EURA', 'EURA'],
      ['MAOG1', 'Miguel Ángel Ortiz'],
    ]);
    const po2 = cadena.ordenes.find((o) => o.ponum === 'PO2')!;
    expect(po2).toMatchObject({
      estatus_etiqueta: 'Autorización 1',
      nivel: 2,
      nivel_etiqueta: 'Nivel 2 · Miguel Ángel Ortiz García',
      dias: 3,
      proveedor: 'PROVEEDOR SA DE CV',
    });
  });

  it('L3: el titular del siguiente nivel llega al 5 (Alejandro Escandón); después del 5, la aprobación final', async () => {
    const { service } = makeService([
      [
        pendingRow('PO5', 'APPR4', 4),
        pendingRow('PO6', 'APPR5', 1),
        pendingRow('PO7', 'APPR5REV', 2),
      ],
      [{ desde: 'APPR4', usuario: 'ALESCA', veces: 7 }],
    ]);
    const cadena = await service.getCadenaMaximo();
    expect(
      cadena.por_nivel.map((n) => [n.nivel, n.etiqueta, n.pendientes]),
    ).toEqual([
      [5, 'Nivel 5 · Alejandro Escandón', 1],
      [6, 'Aprobación final', 1],
      [6, 'Aprobación final (revisión)', 1],
    ]);
    const po5 = cadena.ordenes.find((o) => o.ponum === 'PO5')!;
    expect(po5).toMatchObject({
      estatus_etiqueta: 'Autorización 4',
      nivel_etiqueta: 'Nivel 5 · Alejandro Escandón',
    });
    // el titular no le pone nombre al usuario: sin alias, sale su código
    expect(po5.aprobadores_habituales).toEqual([
      { usuario: 'ALESCA', nombre: 'ALESCA', veces: 7 },
    ]);
    expect(
      cadena.ordenes.find((o) => o.ponum === 'PO7')?.estatus_etiqueta,
    ).toBe('Autorización 5');
    expect(cadena.nota).toContain('titular del nivel');
  });
});

describe('ApprovalChainService.getAprobadores (G5)', () => {
  it('SAP y Maximo por aprobador con su nombre, y tiempos por nivel', async () => {
    const { service } = makeService(
      [
        // aprobaciones de Maximo del periodo. Fechas fijas dentro del periodo
        // por default del doble (hasta el 2026-09-30): con ago(n) la prueba
        // empezó a fallar sola en octubre (las fechas salían del periodo)
        [
          {
            status: 'APPR2',
            changed_by: 'MAOG1',
            change_date: new Date('2026-09-20T16:00:00Z'),
            prev_date: new Date('2026-09-18T16:00:00Z'),
          },
          {
            status: 'APPR',
            changed_by: 'GMV1',
            change_date: new Date('2026-09-22T16:00:00Z'),
            prev_date: new Date('2026-09-20T16:00:00Z'),
          },
        ],
      ],
      [
        {
          code: 1,
          status: 'arsPending',
          current_stage: 1,
          creation_date: ago(4),
          approvers: [
            {
              stage_code: 1,
              user_name: 'Alejandro ESCANDÓN',
              status: 'ardPending',
              update_date: null,
            },
          ],
        },
      ],
    );
    const data = await service.getAprobadores({});
    expect(data.sap).toEqual([
      expect.objectContaining({
        aprobador: 'Alejandro ESCANDÓN',
        aprobadas: expect.objectContaining({ total: 0 }) as unknown,
        pendientes: { total: 1, dias_promedio: 4, dias_max: 4 },
      }),
    ]);
    expect(data.maximo.map((r) => [r.aprobador, r.niveles])).toEqual(
      expect.arrayContaining([
        ['Miguel Ángel Ortiz', ['Nivel 2']],
        ['Gilberto Maltos', ['Aprobación final']],
      ]),
    );
    expect(data.maximo_niveles.map((n) => n.nivel)).toEqual([
      'Nivel 2',
      'Aprobación final',
    ]);
    // L3: la definición ya cuenta el nivel 5
    expect(data.definiciones.maximo).toContain('niveles 1 a 5');
  });

  it('export: hojas SAP, Maximo y Maximo por nivel con el periodo', async () => {
    const { service } = makeService([[]]);
    const { buffer, filename } = await service.exportAprobadores({
      from: '2026-07-01',
      to: '2026-09-28',
    });
    expect(filename).toBe('aprobadores_2026-07-01_2026-09-28.xlsx');
    expect(buffer.length).toBeGreaterThan(0);
  });
});
