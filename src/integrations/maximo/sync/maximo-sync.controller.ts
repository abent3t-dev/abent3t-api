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
import { MaximoSyncService } from './maximo-sync.service';
import { MaximoSyncStatusService } from './maximo-sync-status.service';
import { MAXIMO_SYNC_CONFIG } from './maximo-sync.config';
import type { MaximoSyncConfig } from './maximo-sync.config';
import {
  MaximoSyncDisabledError,
  MaximoSyncInProgressError,
} from './maximo-sync.errors';
import {
  isSyncSkipped,
  MaximoSyncSkipped,
  MaximoSyncTarget,
} from './maximo-sync.types';
import { TriggerMaximoSyncDto } from './dto/trigger-maximo-sync.dto';
import { MaximoRunsQueryDto } from './dto/maximo-runs-query.dto';

// Grupos de roles de compras (mismo patrón que los controllers de compras)
const PURCHASE_ADMINS = ['super_admin', 'lider_procura'];

/**
 * Endpoints de la integración Maximo (Fase INT-3, CLAUDE_COMPRAS.md
 * §Integrations). Vive en `src/integrations/maximo/`, NO en el dominio.
 *
 * Decisión 503-vs-409: con `MAXIMO_SYNC_ENABLED=false` el POST responde
 * **503 Service Unavailable** (la función está apagada por configuración — no
 * es un conflicto de estado) SIN tocar la red; 409 queda reservado para la
 * corrida solapada del mismo target (mutex).
 */
@Controller('integrations/maximo')
export class MaximoSyncController {
  constructor(
    private readonly syncService: MaximoSyncService,
    private readonly statusService: MaximoSyncStatusService,
    @Inject(MAXIMO_SYNC_CONFIG) private readonly syncConfig: MaximoSyncConfig,
  ) {}

  /**
   * Disparo manual asíncrono: 202 + run_id(s); el procesamiento sigue en
   * background (no bloquea la request). target default: 'all'.
   */
  @Roles(...PURCHASE_ADMINS)
  @Post('sync')
  @HttpCode(202)
  async triggerSync(
    @Body() dto: TriggerMaximoSyncDto,
    @CurrentUser() user: { id: string },
  ) {
    if (!this.syncConfig.enabled) {
      throw new ServiceUnavailableException(
        'Sincronización de Maximo deshabilitada (MAXIMO_SYNC_ENABLED=false). Checklist de activación: src/integrations/README.md',
      );
    }
    const requested = dto.target ?? 'all';
    const targets: MaximoSyncTarget[] =
      requested === 'all' ? ['purchase_orders', 'contracts'] : [requested];

    // Pre-chequeo de mutex para responder 409 sin crear ninguna corrida
    // (el service vuelve a validar: la carrera real también termina en 409).
    for (const target of targets) {
      if (this.syncService.isRunning(target)) {
        throw new ConflictException(
          `Ya hay una corrida de sync en curso para "${target}"`,
        );
      }
    }

    const runs: Array<{ target: MaximoSyncTarget; run_id: string }> = [];
    const skipped: MaximoSyncSkipped[] = [];
    const conflicts: Array<{ target: MaximoSyncTarget; reason: string }> = [];
    for (const target of targets) {
      try {
        if (target === 'purchase_orders') {
          runs.push({
            target,
            run_id: await this.syncService.startPurchaseOrders(
              'manual',
              user.id,
            ),
          });
        } else {
          const result = await this.syncService.startContracts(
            'manual',
            user.id,
          );
          if (typeof result === 'string') {
            runs.push({ target, run_id: result });
          } else if (isSyncSkipped(result)) {
            skipped.push(result);
          }
        }
      } catch (error: unknown) {
        // Carrera con el cron entre el pre-chequeo y el start: si YA se aceptó
        // otra corrida en esta misma petición, no se responde 409 (perdería el
        // run_id aceptado) — el conflicto se reporta dentro del 202.
        if (error instanceof MaximoSyncInProgressError) {
          if (runs.length === 0 && conflicts.length + 1 === targets.length) {
            throw new ConflictException(error.message);
          }
          conflicts.push({ target, reason: error.message });
          continue;
        }
        if (error instanceof MaximoSyncDisabledError) {
          throw new ServiceUnavailableException(error.message);
        }
        throw error;
      }
    }
    if (runs.length === 0 && skipped.length === 0 && conflicts.length > 0) {
      throw new ConflictException(conflicts.map((c) => c.reason).join(' | '));
    }
    return { accepted: true, runs, skipped, conflicts };
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
  getRuns(@Query() query: MaximoRunsQueryDto) {
    return this.statusService.getRuns(
      query.target,
      query.page ?? 1,
      query.limit ?? 20,
    );
  }
}
