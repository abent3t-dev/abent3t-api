import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { SapModule } from '../sap.module';
import { SapStagingService } from './sap-staging.service';
import { SapSyncService } from './sap-sync.service';
import { SapSyncStatusService } from './sap-sync-status.service';
import { SapSyncScheduler } from './sap-sync.scheduler';
import { SapSyncController } from './sap-sync.controller';
import { loadSapSyncConfig, SAP_SYNC_CONFIG } from './sap-sync.config';

/**
 * SapSyncModule — Fase INT-4: staging + sync engine + scheduler + endpoints.
 * Gobernado por SAP_SYNC_ENABLED (default false).
 *
 * - Escribe SOLO en nuestra BD (staging); hacia SAP únicamente GET vía
 *   SapClient — el login aislado del SapSessionManager es el único POST (T2).
 * - No es @Global; el dominio de Compras NO lo importa (lee staging vía
 *   Prisma con endpoints propios en src/sap-records/).
 */
@Module({
  imports: [SapModule, ConfigModule, ScheduleModule.forRoot()],
  providers: [
    {
      provide: SAP_SYNC_CONFIG,
      inject: [ConfigService],
      useFactory: loadSapSyncConfig,
    },
    SapStagingService,
    SapSyncService,
    SapSyncStatusService,
    SapSyncScheduler,
  ],
  controllers: [SapSyncController],
  exports: [SapSyncService, SapSyncStatusService, SapStagingService],
})
export class SapSyncModule {}
