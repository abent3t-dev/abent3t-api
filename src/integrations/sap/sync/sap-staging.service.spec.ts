import { SapStagingService } from './sap-staging.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  sapRawHash,
  toSapPurchaseOrder,
  toSapPurchaseRequest,
} from '../sap.mapper';

/**
 * Fase INT-4. Staging con Prisma EN MEMORIA — sin BD. Cubre: insert /
 * update / unchanged por `raw_hash` (el jsonb de ~32 KB NO se reescribe si
 * el documento no cambió) y la carrera P2002 → reintento como update.
 */

type Row = Record<string, unknown> & { id: string };

function makeHarness() {
  const rows: Row[] = [];
  let idSeq = 0;
  let failNextCreateWithP2002 = false;

  const table = {
    findFirst: jest.fn(({ where }: { where: { doc_entry: number } }) =>
      Promise.resolve(
        rows.find((r) => r.doc_entry === where.doc_entry) ?? null,
      ),
    ),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      if (failNextCreateWithP2002) {
        failNextCreateWithP2002 = false;
        // simular que otro proceso insertó la fila en la carrera
        rows.push({ id: `race-${++idSeq}`, ...data });
        return Promise.reject(
          Object.assign(new Error('unique'), { code: 'P2002' }),
        );
      }
      const row: Row = { id: `row-${++idSeq}`, ...data };
      rows.push(row);
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
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
    ),
  };

  const prisma = {
    sap_purchase_orders: table,
    sap_purchase_requests: table,
  };
  const service = new SapStagingService(prisma as unknown as PrismaService);
  return {
    service,
    rows,
    table,
    raceOnce: () => (failNextCreateWithP2002 = true),
  };
}

const rawDoc = (over: Record<string, unknown> = {}) => ({
  DocEntry: 9000,
  DocNum: 6121,
  DocTotal: 500,
  DocumentStatus: 'bost_Open',
  DocumentLines: [],
  ...over,
});

describe('SapStagingService — upsert por doc_entry + raw_hash', () => {
  it('documento nuevo → inserted con hash, raw y mapper_version', async () => {
    const h = makeHarness();
    const raw = rawDoc();
    const outcome = await h.service.upsertPurchaseOrder(
      toSapPurchaseOrder(raw),
      raw,
      'run-1',
    );
    expect(outcome).toBe('inserted');
    expect(h.rows[0].doc_entry).toBe(9000);
    expect(h.rows[0].raw_hash).toBe(sapRawHash(raw));
    expect(h.rows[0].last_sync_run_id).toBe('run-1');
  });

  it('mismo raw → unchanged: solo last_seen_at/run, sin reescribir el jsonb', async () => {
    const h = makeHarness();
    const raw = rawDoc();
    await h.service.upsertPurchaseOrder(toSapPurchaseOrder(raw), raw, 'run-1');
    const outcome = await h.service.upsertPurchaseOrder(
      toSapPurchaseOrder(raw),
      raw,
      'run-2',
    );
    expect(outcome).toBe('unchanged');
    const lastUpdate = h.table.update.mock.calls.at(-1)![0] as {
      data: Record<string, unknown>;
    };
    expect(lastUpdate.data.raw).toBeUndefined();
    expect(lastUpdate.data.last_sync_run_id).toBe('run-2');
    expect(lastUpdate.data.last_changed_at).toBeUndefined();
  });

  it('raw cambiado → updated: re-mapea columnas, hash y last_changed_at', async () => {
    const h = makeHarness();
    const raw = rawDoc();
    await h.service.upsertPurchaseOrder(toSapPurchaseOrder(raw), raw, 'run-1');
    const changed = rawDoc({ DocTotal: 999, DocumentStatus: 'bost_Close' });
    const outcome = await h.service.upsertPurchaseOrder(
      toSapPurchaseOrder(changed),
      changed,
      'run-2',
    );
    expect(outcome).toBe('updated');
    expect(h.rows[0].raw_hash).toBe(sapRawHash(changed));
    expect(h.rows[0].document_status).toBe('bost_Close');
    expect(h.rows[0].last_changed_at).toBeInstanceOf(Date);
  });

  it('carrera de doble insert (P2002) → reintenta y termina en update', async () => {
    const h = makeHarness();
    h.raceOnce();
    const raw = rawDoc();
    const outcome = await h.service.upsertPurchaseOrder(
      toSapPurchaseOrder(raw),
      raw,
      'run-1',
    );
    expect(outcome).toBe('unchanged'); // la fila de la carrera ya trae el mismo hash
  });

  it('purchase_requests: mismo contrato de upsert', async () => {
    const h = makeHarness();
    const raw = {
      DocEntry: 300,
      Requester: 'abnuser27',
      DocumentLines: [{ LineNum: 0, LineTotal: 100, Currency: 'MXN' }],
    };
    const outcome = await h.service.upsertPurchaseRequest(
      toSapPurchaseRequest(raw),
      raw,
      'run-1',
    );
    expect(outcome).toBe('inserted');
    expect(h.rows[0].doc_total).toBe(100);
    expect(h.rows[0].requester).toBe('abnuser27');
  });
});
