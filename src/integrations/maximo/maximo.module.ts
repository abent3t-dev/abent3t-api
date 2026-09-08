import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IntegrationsModule } from '../integrations.module';
import { MaximoClient } from './maximo.client';
import { loadMaximoConfig, MAXIMO_CONFIG } from './maximo.config';

/**
 * MaximoModule — Fase INT-2: cliente tipado de SOLO LECTURA sobre
 * `IntegrationHttpClient` + mapper con fixtures reales.
 *
 * - No es @Global; importa IntegrationsModule explícitamente.
 * - Sin controllers, sin cron, sin persistencia (Int-3).
 * - El dominio de Compras NO importa este módulo.
 */
@Module({
  imports: [IntegrationsModule, ConfigModule],
  providers: [
    {
      provide: MAXIMO_CONFIG,
      inject: [ConfigService],
      useFactory: loadMaximoConfig,
    },
    MaximoClient,
  ],
  exports: [MaximoClient, MAXIMO_CONFIG],
})
export class MaximoModule {}
