import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CURRENT_MAXIMO_POS } from '../common/sql/erp-views.sql';
import {
  buildVendorXref,
  effectiveMaximoVendor,
  MaximoVendorXref,
  MigratedPair,
  VendorMismatchRow,
  vendorMismatchRows,
  vendorMismatchSummary,
} from './maximo-vendor-xref';
import type { EffectiveVendor } from './maximo-vendor-xref';

/**
 * G1 (2026-09-28) — Carga el cruce Maximo → SAP (ver maximo-vendor-xref.ts)
 * y lo cachea: son unas 1,600 OC migradas y cambia solo con los syncs
 * (cada hora), así que basta recalcularlo cada minuto.
 */

const CACHE_MS = 60_000;

type PairRow = MigratedPair;
type AmountRow = {
  vendor_id: string;
  currency: string | null;
  count: number;
  total: unknown;
};

export interface VendorMismatchExportRow extends VendorMismatchRow {
  /** OC vigentes (no canceladas) del proveedor en Maximo. */
  maximo_orders: number;
  /** Monto de esas OC por moneda (nunca sumado entre monedas). */
  maximo_amounts: Array<{ currency: string | null; total: number }>;
}

@Injectable()
export class MaximoVendorXrefService {
  private cache: { at: number; value: Promise<MaximoVendorXref> } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Cruce vigente (cacheado). */
  get(): Promise<MaximoVendorXref> {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > CACHE_MS) {
      const value = this.load();
      this.cache = { at: now, value };
      // Un fallo no se queda cacheado: la siguiente lectura reintenta
      value.catch(() => {
        if (this.cache?.value === value) this.cache = null;
      });
    }
    return this.cache.value;
  }

  /** Proveedor efectivo de una lista de filas de Maximo (OC o contratos). */
  async resolve<
    T extends {
      vendor_id: string | null;
      vendor_name: string | null;
      ponum?: string | null;
    },
  >(rows: T[]): Promise<Array<T & { supplier: EffectiveVendor }>> {
    if (rows.length === 0) return [];
    const xref = await this.get();
    return rows.map((row) => ({
      ...row,
      supplier: effectiveMaximoVendor(row, xref),
    }));
  }

  async mismatchSummary() {
    return vendorMismatchSummary(await this.get());
  }

  /** Lista para que Alfredo corrija el maestro de Maximo (G1.3). */
  async mismatchRows(): Promise<VendorMismatchExportRow[]> {
    const rows = vendorMismatchRows(await this.get());
    if (rows.length === 0) return [];
    const codes = [...new Set(rows.map((r) => r.maximo_code))];
    const amounts = await this.prisma.$queryRaw<AmountRow[]>(Prisma.sql`
      WITH current AS (${CURRENT_MAXIMO_POS})
      SELECT vendor_id, currency, count(*)::int AS count,
             coalesce(sum(total_cost), 0) AS total
      FROM current
      WHERE vendor_id IN (${Prisma.join(codes)})
        AND coalesce(status, '') NOT IN ('CAN', 'CANCEL')
      GROUP BY vendor_id, currency`);
    const byVendor = new Map<string, AmountRow[]>();
    for (const a of amounts) {
      byVendor.set(a.vendor_id, [...(byVendor.get(a.vendor_id) ?? []), a]);
    }
    return rows.map((row) => {
      const list = byVendor.get(row.maximo_code) ?? [];
      return {
        ...row,
        maximo_orders: list.reduce((sum, a) => sum + Number(a.count), 0),
        maximo_amounts: list
          .map((a) => ({ currency: a.currency, total: Number(a.total) }))
          .sort((a, b) => b.total - a.total),
      };
    });
  }

  private async load(): Promise<MaximoVendorXref> {
    // (a) cada OC vigente de Maximo con la OC de SAP que la migró (si hay
    // varias, la no cancelada más reciente)
    const pairs = await this.prisma.$queryRaw<PairRow[]>(Prisma.sql`
      WITH current AS (${CURRENT_MAXIMO_POS})
      SELECT c.ponum, c.vendor_id, c.vendor_name, s.card_code, s.card_name
      FROM current c
      JOIN LATERAL (
        SELECT sp.card_code, sp.card_name
        FROM sap_purchase_orders sp
        WHERE sp.maximo_ponum = c.ponum AND sp.card_code IS NOT NULL
        ORDER BY (sp.cancelled IS TRUE), sp.doc_entry DESC
        LIMIT 1
      ) s ON true
      ORDER BY c.ponum`);
    const codes = [...new Set(pairs.map((p) => p.card_code))];
    const partners =
      codes.length === 0
        ? []
        : await this.prisma.sap_business_partners.findMany({
            where: { card_code: { in: codes } },
            select: { card_code: true, card_name: true },
          });
    const bpNames = new Map<string, string>();
    for (const bp of partners) {
      if (bp.card_name) bpNames.set(bp.card_code, bp.card_name);
    }
    return buildVendorXref(pairs, bpNames);
  }
}
