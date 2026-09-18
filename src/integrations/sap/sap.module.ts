import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IntegrationsModule } from '../integrations.module';
import { loadSapConfig, SAP_CONFIG } from './sap.config';
import { SapSessionManager } from './sap-session.manager';
import { SapClient } from './sap.client';

/**
 * SapModule — Fase INT-4: cliente de SOLO LECTURA del Service Layer de
 * SAP B1 sobre la infraestructura de Int-1.
 *
 * - Config por env vars `SL_*` (T1); sin credenciales el módulo arranca y
 *   los métodos fallan con `SapNotConfiguredError` sin tocar la red.
 * - El POST /Login vive aislado en `SapSessionManager` (T2); el cliente
 *   genérico GET-only de Int-1 no se modifica.
 * - No es @Global; el dominio de Compras NO lo importa (lee staging).
 */
@Module({
  imports: [IntegrationsModule, ConfigModule],
  providers: [
    {
      provide: SAP_CONFIG,
      inject: [ConfigService],
      useFactory: loadSapConfig,
    },
    SapSessionManager,
    SapClient,
  ],
  exports: [SapClient, SapSessionManager, SAP_CONFIG],
})
export class SapModule {}
