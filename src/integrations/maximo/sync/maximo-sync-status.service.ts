import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PaginatedResponse } from '../../../common/interfaces/paginated-response.interface';
import { MaximoSyncService } from './maximo-sync.service';
import { MAXIMO_SYNC_CONFIG } from './maximo-sync.config';
import type { MaximoSyncConfig } from './maximo-sync.config';
import { MAXIMO_CONFIG } from '../maximo.config';
import type { MaximoConfig } from '../maximo.config';
import { MAXIMO_SYNC_TARGETS, MaximoSyncTarget } from './maximo-sync.types';
import { Inject } from '@nestjs/common';

/**
 * Consultas de estado del sync (GET /integrations/maximo/status|runs).
 * Solo lectura sobre staging/corridas; sin red.
 */
@Injectable()
export class MaximoSyncStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly syncService: MaximoSyncService,
    @Inject(MAXIMO_SYNC_CONFIG) private readonly syncConfig: MaximoSyncConfig,
    @Inject(MAXIMO_CONFIG) private readonly maximoConfig: MaximoConfig,
  ) {}

  async getStatus() {
    const [lastPoRun, lastContractRun, poCount, contractCount] =
      await Promise.all([
        this.lastRun('purchase_orders'),
        this.lastRun('contracts'),
        this.prisma.maximo_purchase_orders.count(),
        this.prisma.maximo_contracts.count(),
      ]);

    return {
      enabled: this.syncConfig.enabled,
      contractsEnabled: this.maximoConfig.contractsEnabled,
      intervalMinutes: this.syncConfig.intervalMinutes,
      pageSize: this.syncConfig.pageSize,
      running: MAXIMO_SYNC_TARGETS.filter((t) => this.syncService.isRunning(t)),
      lastRuns: {
        purchase_orders: lastPoRun,
        contracts: lastContractRun,
      },
      counts: {
        purchase_orders: poCount,
        contracts: contractCount,
      },
    };
  }

  async getRuns(
    target: MaximoSyncTarget | undefined,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<unknown>> {
    const where = target ? { target } : {};
    const [total, data] = await Promise.all([
      this.prisma.maximo_sync_runs.count({ where }),
      this.prisma.maximo_sync_runs.findMany({
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

  private lastRun(target: MaximoSyncTarget) {
    return this.prisma.maximo_sync_runs.findFirst({
      where: { target },
      orderBy: { started_at: 'desc' },
    });
  }
}
