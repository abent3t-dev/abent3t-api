import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PlatformsController } from './platforms.controller';
import { PlatformsService } from './platforms.service';
import { PlatformSyncService } from './sync/platform-sync.service';
import { CrehanaClient } from './clients/crehana';
import { SupabaseModule } from '../supabase/supabase.module';

/**
 * Módulo de integración con plataformas de e-learning (Crehana, Udemy, etc.)
 *
 * Sincronización automática habilitada con @nestjs/schedule
 * - Cron job cada 6 horas para sincronizar progreso
 * - Sincronización manual disponible via API
 */
@Module({
  imports: [
    SupabaseModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [PlatformsController],
  providers: [
    PlatformsService,
    PlatformSyncService,
    CrehanaClient,
  ],
  exports: [PlatformsService, PlatformSyncService],
})
export class PlatformsModule {}
