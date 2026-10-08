import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PaginatedResponse } from '../../../common/interfaces/paginated-response.interface';
import { SapSyncService } from './sap-sync.service';
import {
  SAP_SYNC_CONFIG,
  SAP_SYNC_FULL_DAILY_TIME_ZONE,
} from './sap-sync.config';
import type { SapSyncConfig } from './sap-sync.config';
import {
  SAP_FULL_DAILY_TARGETS,
  SAP_SYNC_TARGETS,
  SapSyncTarget,
} from './sap-sync.types';

/**
 * Consultas de estado del sync SAP (GET /integrations/sap/status|runs).
 * Solo lectura sobre staging/corridas; sin red.
 *
 * L1 (2026-10-08): el status trae la configuración del full diario
 * (`fullDaily`) y el último full EXITOSO por target (`lastFullSuccess`), para
 * que Integraciones muestre si el full diario dejó de correr. Las corridas
 * traen `records_remapped`.
 */
@Injectable()
export class SapSyncStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly syncService: SapSyncService,
    @Inject(SAP_SYNC_CONFIG) private readonly syncConfig: SapSyncConfig,
  ) {}

  async getStatus() {
    const [
      lastPoRun,
      lastPrRun,
      lastBpRun,
      lastArRun,
      poCount,
      prCount,
      bpCount,
      arCount,
      lastPoFull,
      lastPrFull,
      lastBpFull,
      lastArFull,
    ] = await Promise.all([
      this.lastRun('purchase_orders'),
      this.lastRun('purchase_requests'),
      this.lastRun('business_partners'),
      this.lastRun('approval_requests'),
      this.prisma.sap_purchase_orders.count(),
      this.prisma.sap_purchase_requests.count(),
      this.prisma.sap_business_partners.count(),
      this.prisma.sap_approval_requests.count(),
      this.lastFullSuccess('purchase_orders'),
      this.lastFullSuccess('purchase_requests'),
      this.lastFullSuccess('business_partners'),
      this.lastFullSuccess('approval_requests'),
    ]);

    return {
      enabled: this.syncConfig.enabled,
      intervalMinutes: this.syncConfig.intervalMinutes,
      pageSize: this.syncConfig.pageSize,
      // L1: `at` null = apagado (SAP_SYNC_FULL_DAILY_AT=off)
      fullDaily: {
        at: this.syncConfig.fullDailyAt,
        timeZone: SAP_SYNC_FULL_DAILY_TIME_ZONE,
        targets: SAP_FULL_DAILY_TARGETS,
      },
      running: SAP_SYNC_TARGETS.filter((t) => this.syncService.isRunning(t)),
      lastRuns: {
        purchase_orders: lastPoRun,
        purchase_requests: lastPrRun,
        business_partners: lastBpRun,
        approval_requests: lastArRun,
      },
      lastFullSuccess: {
        purchase_orders: lastPoFull,
        purchase_requests: lastPrFull,
        business_partners: lastBpFull,
        approval_requests: lastArFull,
      },
      counts: {
        purchase_orders: poCount,
        purchase_requests: prCount,
        business_partners: bpCount,
        approval_requests: arCount,
      },
    };
  }

  async getRuns(
    target: SapSyncTarget | undefined,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<unknown>> {
    const where = target ? { target } : {};
    const [total, data] = await Promise.all([
      this.prisma.sap_sync_runs.count({ where }),
      this.prisma.sap_sync_runs.findMany({
        where,
        orderBy: { started_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  private lastRun(target: SapSyncTarget) {
    return this.prisma.sap_sync_runs.findFirst({
      where: { target },
      orderBy: { started_at: 'desc' },
    });
  }

  /** L1: último full con status success del target (manual o del cron). */
  private lastFullSuccess(target: SapSyncTarget) {
    return this.prisma.sap_sync_runs.findFirst({
      where: { target, mode: 'full', status: 'success' },
      orderBy: { started_at: 'desc' },
      select: {
        id: true,
        triggered_by: true,
        started_at: true,
        finished_at: true,
      },
    });
  }
}
