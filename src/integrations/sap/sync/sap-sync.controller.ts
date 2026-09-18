import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { SapSyncService } from './sap-sync.service';
import { SapSyncStatusService } from './sap-sync-status.service';
import { SAP_SYNC_CONFIG } from './sap-sync.config';
import type { SapSyncConfig } from './sap-sync.config';
import {
  SapSyncDisabledError,
  SapSyncInProgressError,
} from './sap-sync.errors';
import { SapSyncTarget } from './sap-sync.types';
import { TriggerSapSyncDto } from './dto/trigger-sap-sync.dto';
import { SapRunsQueryDto } from './dto/sap-runs-query.dto';

// Grupos de roles de compras (mismo patrón que los controllers de compras)
const PURCHASE_ADMINS = ['super_admin', 'lider_procura'];

/**
 * Endpoints de la integración SAP (Fase INT-4). Vive en
 * `src/integrations/sap/`, NO en el dominio.
 *
 * Misma decisión 503-vs-409 que Maximo: con `SAP_SYNC_ENABLED=false` el
 * POST responde **503** (función apagada por configuración) sin tocar la
 * red; 409 queda reservado para la corrida solapada del mismo target.
 */
@Controller('integrations/sap')
export class SapSyncController {
  constructor(
    private readonly syncService: SapSyncService,
    private readonly statusService: SapSyncStatusService,
    @Inject(SAP_SYNC_CONFIG) private readonly syncConfig: SapSyncConfig,
  ) {}

  /**
   * Disparo manual asíncrono: 202 + run_id(s); el procesamiento sigue en
   * background. target default: 'all'; mode default: incremental si el
   * staging ya tiene datos.
   */
  @Roles(...PURCHASE_ADMINS)
  @Post('sync')
  @HttpCode(202)
  async triggerSync(
    @Body() dto: TriggerSapSyncDto,
    @CurrentUser() user: { id: string },
  ) {
    if (!this.syncConfig.enabled) {
      throw new ServiceUnavailableException(
        'Sincronización de SAP deshabilitada (SAP_SYNC_ENABLED=false). Plan de activación: src/integrations/README.md',
      );
    }
    const requested = dto.target ?? 'all';
    const targets: SapSyncTarget[] =
      requested === 'all'
        ? ['purchase_orders', 'purchase_requests']
        : [requested];

    // Pre-chequeo de mutex para responder 409 sin crear ninguna corrida
    // (el service vuelve a validar: la carrera real también termina en 409).
    for (const target of targets) {
      if (this.syncService.isRunning(target)) {
        throw new ConflictException(
          `Ya hay una corrida de sync en curso para "${target}"`,
        );
      }
    }

    const runs: Array<{ target: SapSyncTarget; run_id: string }> = [];
    const conflicts: Array<{ target: SapSyncTarget; reason: string }> = [];
    for (const target of targets) {
      try {
        runs.push({
          target,
          run_id: await this.syncService.startTarget(
            target,
            'manual',
            user.id,
            dto.mode,
          ),
        });
      } catch (err: unknown) {
        // Carrera con el cron entre el pre-chequeo y el start: si YA se
        // aceptó otra corrida en esta petición, el conflicto se reporta
        // dentro del 202 para no perder el run_id aceptado.
        if (err instanceof SapSyncInProgressError) {
          if (runs.length === 0 && conflicts.length + 1 === targets.length) {
            throw new ConflictException(err.message);
          }
          conflicts.push({ target, reason: err.message });
          continue;
        }
        if (err instanceof SapSyncDisabledError) {
          throw new ServiceUnavailableException(err.message);
        }
        throw err;
      }
    }
    if (runs.length === 0 && conflicts.length > 0) {
      throw new ConflictException(conflicts.map((c) => c.reason).join(' | '));
    }
    return { accepted: true, runs, conflicts };
  }

  /** Estado consultable (lectura): flags, corridas en curso, últimas corridas, conteos. */
  @Roles(...PURCHASE_ADMINS, 'executive')
  @Get('status')
  getStatus() {
    return this.statusService.getStatus();
  }

  /** Historial de corridas paginado. */
  @Roles(...PURCHASE_ADMINS)
  @Get('runs')
  getRuns(@Query() query: SapRunsQueryDto) {
    return this.statusService.getRuns(
      query.target,
      query.page ?? 1,
      query.limit ?? 20,
    );
  }
}
