import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { MaximoModule } from '../maximo.module';
import { MaximoStagingService } from './maximo-staging.service';
import { MaximoSyncService } from './maximo-sync.service';
import { MaximoSyncStatusService } from './maximo-sync-status.service';
import { MaximoRemapService } from './maximo-remap.service';
import { MaximoSeedService } from './maximo-seed.service';
import { MaximoSyncScheduler } from './maximo-sync.scheduler';
import { MaximoSyncController } from './maximo-sync.controller';
import { loadMaximoSyncConfig, MAXIMO_SYNC_CONFIG } from './maximo-sync.config';

/**
 * MaximoSyncModule — Fase INT-3: staging + sync engine + scheduler +
 * endpoints + seed dev. Gobernado por MAXIMO_SYNC_ENABLED (default false).
 *
 * - Escribe SOLO en nuestra BD (staging); hacia Maximo únicamente GET vía
 *   MaximoClient (Int-2) — ningún camino HTTP nuevo.
 * - No es @Global; el dominio de Compras NO lo importa (Int-5 leerá staging
 *   vía Prisma con endpoints propios del dominio).
 */
@Module({
  imports: [MaximoModule, ConfigModule, ScheduleModule.forRoot()],
  providers: [
    {
      provide: MAXIMO_SYNC_CONFIG,
      inject: [ConfigService],
      useFactory: loadMaximoSyncConfig,
    },
    MaximoStagingService,
    MaximoSyncService,
    MaximoSyncStatusService,
    MaximoRemapService,
    MaximoSeedService,
    MaximoSyncScheduler,
  ],
  controllers: [MaximoSyncController],
  exports: [
    MaximoSyncService,
    MaximoSyncStatusService,
    MaximoStagingService,
    MaximoRemapService,
    MaximoSeedService,
  ],
})
export class MaximoSyncModule {}
