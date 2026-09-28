import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ErpAliasesService } from '../erp-aliases/erp-aliases.service';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import { maximoVendorNote } from '../erp-vendors/maximo-vendor-xref';
import {
  CURRENT_MAXIMO_POS,
  maximoInApproval,
  maximoStatusSince,
} from '../common/sql/erp-views.sql';
import { maximoStatusLabel } from '../common/utils/maximo-status.util';
import {
  buildWorkbook,
  excelSheet,
  NO_DISPONIBLE,
} from '../common/utils/excel-export.util';
import type { ExcelColumn } from '../common/utils/excel-export.util';
import { averageAndMedian } from '../purchase-dashboard/sap-gestion-days';
import {
  ApproverSummary,
  maximoApproverEvents,
  maximoPendingLevel,
  MaximoLevelTimes,
  sapApproverEvents,
  summarizeApprovers,
  summarizeMaximoLevels,
} from './approver-stats';
import {
  loadMaximoApprovals,
  loadMaximoNextApprovers,
  loadSapApprovalDocs,
} from './approver-data';
import { PurchaseReportsService } from './purchase-reports.service';
import { ReportPeriodDto } from './dto/report-period.dto';

/**
 * G5/G6 (reunión con Ingrid 2026-09-28) — Aprobaciones por persona y cadena
 * de aprobación de Maximo. Regla en approver-stats.ts: días desde que el
 * documento LE LLEGÓ al aprobador; pendientes de hoy con su antigüedad.
 *
 *  - Histórico por aprobador (con periodo): SAP y Maximo, más los tiempos
 *    por nivel de la cadena de Maximo; export con el mismo periodo.
 *  - Cadena de Maximo (hoy): OC en aprobación (WAPPR / APPRn / APPRnREV)
 *    por nivel que esperan, con los aprobadores habituales de ese paso
 *    (quién suele hacer la siguiente aprobación desde ese estatus). Maximo
 *    no dice a qué persona exacta le toca: eso sería el workflow.
 */

export interface ApproverRow extends ApproverSummary {
  /** Nombre (alias de Compras) o el usuario del ERP. */
  aprobador: string;
}

export interface MaximoPendingOrder {
  ponum: string;
  descripcion: string | null;
  estatus: string | null;
  estatus_etiqueta: string;
  nivel: number | null;
  nivel_etiqueta: string;
  proveedor: string | null;
  proveedor_codigo: string | null;
  proveedor_nota: string | null;
  monto: number | null;
  moneda: string | null;
  desde: Date | null;
  dias: number | null;
  aprobadores_habituales: Array<{
    usuario: string;
    nombre: string;
    veces: number;
  }>;
}

type PendingSqlRow = {
  ponum: string;
  description: string | null;
  status: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  total_cost: unknown;
  currency: string | null;
  desde: Date | null;
};

const MS_PER_DAY = 86_400_000;
const PENDING_LIMIT = 500;
const HABITUAL_LIMIT = 3;

const DEFINICIONES = {
  sap: 'SAP: días desde que la solicitud de autorización le llegó (la aprobación de la etapa anterior; en la primera etapa, la creación) hasta su decisión. Pendientes: las de su etapa actual, con los días que llevan con él.',
  maximo:
    'Maximo: cada aprobación del historial de la OC (nivel 1, 2, 3, 4, final o revisión) cuenta desde el cambio de estatus anterior, que es cuando le llegó. Maximo no registra rechazos ni a quién le toca lo pendiente: lo pendiente se ve por nivel en la cadena.',
};

@Injectable()
export class ApprovalChainService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: PurchaseReportsService,
    private readonly aliases: ErpAliasesService,
    private readonly vendors: MaximoVendorXrefService,
  ) {}

  /** G5: aprobadas, rechazadas y pendientes por aprobador en el periodo. */
  async getAprobadores(dto: ReportPeriodDto) {
    const period = this.reports.resolvePeriod(dto);
    const [docs, maximoRows] = await Promise.all([
      loadSapApprovalDocs(this.prisma),
      loadMaximoApprovals(this.prisma, period),
    ]);
    const sap = summarizeApprovers(
      sapApproverEvents(docs, new Date()),
      period,
      {
        withPending: true,
        withRejected: true,
      },
    );
    const maximo = summarizeApprovers(
      maximoApproverEvents(maximoRows),
      period,
      {
        withPending: false,
        withRejected: false,
      },
    );
    const [sapNames, maximoNames] = await Promise.all([
      this.aliases.resolveMany(
        'sap',
        sap.map((r) => r.usuario),
      ),
      this.aliases.resolveMany(
        'maximo',
        maximo.map((r) => r.usuario),
      ),
    ]);
    const named = (rows: ApproverSummary[], names: Map<string, string>) =>
      rows.map(
        (r): ApproverRow => ({
          ...r,
          aprobador: names.get(r.usuario) ?? r.usuario,
        }),
      );
    return {
      periodo: {
        from: period.from.toISOString().slice(0, 10),
        to: period.to.toISOString().slice(0, 10),
      },
      sap: named(sap, sapNames),
      maximo: named(maximo, maximoNames),
      maximo_niveles: summarizeMaximoLevels(maximoRows, period),
      definiciones: DEFINICIONES,
      generated_at: new Date().toISOString(),
    };
  }

  /** G6: OC de Maximo en aprobación hoy, por nivel, con sus aprobadores habituales. */
  async getCadenaMaximo() {
    const [pending, next] = await Promise.all([
      this.prisma.$queryRaw<PendingSqlRow[]>(Prisma.sql`
        WITH current AS (${CURRENT_MAXIMO_POS})
        SELECT c.ponum, c.description, c.status, c.vendor_id, c.vendor_name,
               c.total_cost, c.currency, ${maximoStatusSince('c')} AS desde
        FROM current c
        WHERE ${maximoInApproval('c')}
        ORDER BY 8 ASC NULLS LAST, c.ponum
        LIMIT ${PENDING_LIMIT + 1}`),
      loadMaximoNextApprovers(this.prisma),
    ]);
    const rows = pending.slice(0, PENDING_LIMIT);
    const [resolved, names] = await Promise.all([
      this.vendors.resolve(rows),
      this.aliases.resolveMany(
        'maximo',
        next.map((n) => n.usuario),
      ),
    ]);
    // Quién suele hacer la siguiente aprobación desde cada estatus
    const habitualBy = new Map<
      string,
      MaximoPendingOrder['aprobadores_habituales']
    >();
    for (const n of next) {
      const list = habitualBy.get(n.desde) ?? [];
      if (list.length < HABITUAL_LIMIT) {
        list.push({
          usuario: n.usuario,
          nombre: names.get(n.usuario) ?? n.usuario,
          veces: n.veces,
        });
      }
      habitualBy.set(n.desde, list);
    }
    const now = Date.now();
    const ordenes: MaximoPendingOrder[] = resolved.map((row) => {
      const level = maximoPendingLevel(row.status);
      const since = row.desde ? new Date(row.desde).getTime() : null;
      return {
        ponum: row.ponum,
        descripcion: row.description,
        estatus: row.status,
        estatus_etiqueta: maximoStatusLabel(row.status),
        nivel: level?.nivel ?? null,
        nivel_etiqueta: level?.etiqueta ?? 'Sin nivel',
        proveedor: row.supplier.name,
        proveedor_codigo: row.supplier.code,
        proveedor_nota: maximoVendorNote(row.supplier),
        monto: row.total_cost === null ? null : Number(row.total_cost),
        moneda: row.currency,
        desde: row.desde,
        dias:
          since === null
            ? null
            : Math.max(0, Math.floor((now - since) / MS_PER_DAY)),
        aprobadores_habituales: row.status
          ? (habitualBy.get(row.status) ?? [])
          : [],
      };
    });

    // Resumen por nivel pendiente (la etiqueta junta APPRn y APPRnREV)
    const byLevel = new Map<string, MaximoPendingOrder[]>();
    for (const o of ordenes) {
      byLevel.set(o.nivel_etiqueta, [
        ...(byLevel.get(o.nivel_etiqueta) ?? []),
        o,
      ]);
    }
    const porNivel = [...byLevel.entries()]
      .map(([etiqueta, list]) => {
        const days = list
          .map((o) => o.dias)
          .filter((d): d is number => d !== null);
        const habituales = new Map<
          string,
          { usuario: string; nombre: string; veces: number }
        >();
        for (const o of list) {
          for (const h of o.aprobadores_habituales) {
            if (!habituales.has(h.usuario)) habituales.set(h.usuario, h);
          }
        }
        return {
          nivel: list[0].nivel,
          etiqueta,
          pendientes: list.length,
          dias_max: days.length === 0 ? null : Math.max(...days),
          dias_promedio: averageAndMedian(days).promedio_dias,
          aprobadores_habituales: [...habituales.values()]
            .sort((a, b) => b.veces - a.veces)
            .slice(0, HABITUAL_LIMIT),
        };
      })
      .sort(
        (a, b) =>
          (a.nivel ?? 99) - (b.nivel ?? 99) ||
          a.etiqueta.localeCompare(b.etiqueta),
      );

    return {
      total: pending.length > PENDING_LIMIT ? pending.length : ordenes.length,
      truncado: pending.length > PENDING_LIMIT,
      por_nivel: porNivel,
      ordenes,
      nota: 'Nivel que espera cada OC: WAPPR → nivel 1; APPRn → nivel n+1 o la aprobación final (según el monto). Aprobadores habituales = quién suele hacer la siguiente aprobación desde ese estatus; Maximo no dice a quién le toca exactamente.',
      generated_at: new Date().toISOString(),
    };
  }

  /** G5.3: Excel del histórico por aprobador con el mismo periodo. */
  async exportAprobadores(
    dto: ReportPeriodDto,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.getAprobadores(dto);
    const days = (v: number | null | undefined) =>
      v === null || v === undefined ? NO_DISPONIBLE : v;
    const common: ExcelColumn<ApproverRow>[] = [
      { header: 'Aprobador', value: (r) => r.aprobador, width: 30 },
      { header: 'Usuario', value: (r) => r.usuario, width: 20 },
      {
        header: 'Aprobadas',
        value: (r) => r.aprobadas.total,
        kind: 'int',
        width: 11,
      },
      {
        header: 'Días promedio (desde que le llegó)',
        value: (r) => days(r.aprobadas.dias_promedio),
        width: 18,
      },
      {
        header: 'Días mediana',
        value: (r) => days(r.aprobadas.dias_mediana),
        width: 13,
      },
      {
        header: 'Días máximo',
        value: (r) => days(r.aprobadas.dias_max),
        width: 12,
      },
    ];
    const sapColumns: ExcelColumn<ApproverRow>[] = [
      ...common,
      {
        header: 'Rechazadas',
        value: (r) => r.rechazadas ?? NO_DISPONIBLE,
        width: 11,
      },
      {
        header: 'Pendientes hoy',
        value: (r) => r.pendientes?.total ?? NO_DISPONIBLE,
        width: 13,
      },
      {
        header: 'Antigüedad promedio (días)',
        value: (r) => days(r.pendientes?.dias_promedio),
        width: 16,
      },
      {
        header: 'Antigüedad máxima (días)',
        value: (r) => days(r.pendientes?.dias_max),
        width: 16,
      },
    ];
    const maximoColumns: ExcelColumn<ApproverRow>[] = [
      ...common,
      {
        header: 'Niveles',
        value: (r) => (r.niveles ?? []).join(', '),
        width: 30,
      },
    ];
    const levelColumns: ExcelColumn<MaximoLevelTimes>[] = [
      { header: 'Nivel', value: (r) => r.nivel, width: 24 },
      {
        header: 'Aprobaciones',
        value: (r) => r.aprobaciones,
        kind: 'int',
        width: 13,
      },
      {
        header: 'Días promedio',
        value: (r) => days(r.dias_promedio),
        width: 14,
      },
      { header: 'Días mediana', value: (r) => days(r.dias_mediana), width: 13 },
    ];
    const buffer = await buildWorkbook(
      [
        excelSheet('SAP', sapColumns, data.sap),
        excelSheet('Maximo', maximoColumns, data.maximo),
        excelSheet('Maximo por nivel', levelColumns, data.maximo_niveles),
      ],
      [
        `Aprobaciones por aprobador del ${data.periodo.from} al ${data.periodo.to} (por la fecha de la decisión). Pendientes: al día de hoy.`,
        DEFINICIONES.sap,
        DEFINICIONES.maximo,
      ],
    );
    return {
      buffer,
      filename: `aprobadores_${data.periodo.from}_${data.periodo.to}.xlsx`,
    };
  }
}
