import { PrismaService } from '../prisma/prisma.service';
import { SupplierSapMirrorService } from './supplier-sap-mirror.service';

/**
 * Espejo staging SAP → catálogo suppliers. Prisma EN MEMORIA con los
 * índices únicos simulados (tax_id y (source, external_id)). Cubre: alta
 * con básicos, cascada de tax_id ante RFC duplicado, idempotencia,
 * actualización de SOLO los básicos y preservación de lo que es de ABENT
 * (puntuación, bloqueo, is_active).
 */

type Row = Record<string, unknown> & { id: string };

function makeHarness(staged: Array<Record<string, unknown>>) {
  const suppliers: Row[] = [];
  let idSeq = 0;

  const uniqueViolation = (
    data: Record<string, unknown>,
    exceptId?: string,
  ): boolean =>
    suppliers.some(
      (s) =>
        s.id !== exceptId &&
        (s.tax_id === data.tax_id ||
          (data.external_id != null &&
            s.source === data.source &&
            s.external_id === data.external_id)),
    );

  const prisma = {
    sap_business_partners: {
      findMany: jest.fn(
        ({
          where,
          take,
        }: {
          where: { card_code?: { gt: string } };
          take: number;
        }) => {
          const after = where?.card_code?.gt ?? '';
          const rows = staged
            .filter((r) => (r.card_code as string) > after)
            .sort((a, b) =>
              (a.card_code as string).localeCompare(b.card_code as string),
            )
            .slice(0, take);
          return Promise.resolve(rows);
        },
      ),
    },
    suppliers: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const found = suppliers.find((s) =>
          Object.entries(where).every(([k, v]) => s[k] === v),
        );
        return Promise.resolve(found ?? null);
      }),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        if (uniqueViolation(data)) {
          return Promise.reject(
            Object.assign(new Error('unique'), { code: 'P2002' }),
          );
        }
        const row: Row = {
          id: `sup-${++idSeq}`,
          performance_score: 0,
          is_blocked: false,
          ...data,
        };
        suppliers.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = suppliers.find((s) => s.id === where.id)!;
          if (
            data.tax_id !== undefined &&
            uniqueViolation({ tax_id: data.tax_id }, row.id)
          ) {
            return Promise.reject(
              Object.assign(new Error('unique'), { code: 'P2002' }),
            );
          }
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
    },
  };

  const service = new SupplierSapMirrorService(
    prisma as unknown as PrismaService,
  );
  return { service, suppliers, prisma };
}

const bp = (over: Record<string, unknown> = {}) => ({
  card_code: 'P0000001',
  card_name: 'PROVEEDOR UNO SA DE CV',
  federal_tax_id: 'PUN010101AAA',
  email: 'ventas@uno.mx',
  phone1: '5511122233',
  contact_person: 'María',
  currency: 'MXN',
  sap_valid: true,
  sap_frozen: false,
  ...over,
});

describe('SupplierSapMirrorService', () => {
  it('crea proveedores nuevos con los básicos + source/external_id', async () => {
    const h = makeHarness([bp()]);
    const summary = await h.service.runMirror();
    expect(summary).toMatchObject({ scanned: 1, created: 1, conflicts: 0 });
    expect(h.suppliers[0]).toMatchObject({
      legal_name: 'PROVEEDOR UNO SA DE CV',
      tax_id: 'PUN010101AAA',
      source: 'sap',
      external_id: 'P0000001',
      currency: 'MXN',
      sap_valid: true,
      is_active: true,
    });
  });

  it('RFC duplicado → cascada RFC-CardCode → CardCode (nunca se pierde la fila)', async () => {
    const h = makeHarness([
      bp({ card_code: 'P1', federal_tax_id: 'XEXX010101000' }),
      bp({ card_code: 'P2', federal_tax_id: 'XEXX010101000' }),
      bp({ card_code: 'P3', federal_tax_id: 'XEXX010101000' }),
    ]);
    const summary = await h.service.runMirror();
    expect(summary.created).toBe(3);
    const taxIds = h.suppliers.map((s) => s.tax_id).sort();
    expect(taxIds).toEqual([
      'XEXX010101000',
      'XEXX010101000-P2',
      'XEXX010101000-P3',
    ]);
  });

  it('segunda pasada sin cambios → todo unchanged (idempotente)', async () => {
    const h = makeHarness([bp(), bp({ card_code: 'P0000002' })]);
    await h.service.runMirror();
    const second = await h.service.runMirror();
    expect(second).toMatchObject({
      scanned: 2,
      created: 0,
      updated: 0,
      unchanged: 2,
    });
  });

  it('cambio en staging → update de SOLO básicos; puntuación/bloqueo/activo de ABENT intactos', async () => {
    const staged = [bp()];
    const h = makeHarness(staged);
    await h.service.runMirror();
    // ABENT califica y bloquea al proveedor
    Object.assign(h.suppliers[0], {
      performance_score: 87.5,
      is_blocked: true,
      blocked_reason: 'incumplimiento',
      is_active: false,
    });
    // SAP cambia nombre y congela
    Object.assign(staged[0], {
      card_name: 'PROVEEDOR UNO RENOMBRADO',
      sap_frozen: true,
    });
    const summary = await h.service.runMirror();
    expect(summary.updated).toBe(1);
    expect(h.suppliers[0]).toMatchObject({
      legal_name: 'PROVEEDOR UNO RENOMBRADO',
      sap_frozen: true,
      performance_score: 87.5, // de ABENT: intacto
      is_blocked: true,
      blocked_reason: 'incumplimiento',
      is_active: false, // desactivado a mano: NO se revive
    });
    // el update jamás envía campos de ABENT
    const sentKeys = h.prisma.suppliers.update.mock.calls.flatMap((c) =>
      Object.keys((c[0] as { data: Record<string, unknown> }).data),
    );
    expect(sentKeys).not.toContain('performance_score');
    expect(sentKeys).not.toContain('is_blocked');
    expect(sentKeys).not.toContain('is_active');
  });

  it('BP sin RFC usa el CardCode como tax_id; sin nombre usa CardCode como razón social', async () => {
    const h = makeHarness([
      bp({ card_code: 'E0000009', federal_tax_id: null, card_name: null }),
    ]);
    await h.service.runMirror();
    expect(h.suppliers[0].tax_id).toBe('E0000009');
    expect(h.suppliers[0].legal_name).toBe('E0000009');
  });

  it('conflicto irresoluble (todos los candidatos ocupados por manuales) → conteo y fila omitida', async () => {
    const h = makeHarness([bp({ card_code: 'P9', federal_tax_id: 'AAA' })]);
    // proveedor MANUAL ya ocupa el RFC, el combinado y el CardCode
    h.suppliers.push(
      { id: 'm1', tax_id: 'AAA', source: 'manual', external_id: null },
      { id: 'm2', tax_id: 'AAA-P9', source: 'manual', external_id: null },
      { id: 'm3', tax_id: 'P9', source: 'manual', external_id: null },
    );
    const summary = await h.service.runMirror();
    expect(summary.conflicts).toBe(1);
    expect(summary.created).toBe(0);
  });
});
