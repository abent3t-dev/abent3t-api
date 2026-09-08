import { Module } from '@nestjs/common';
import { IntegrationHttpClientFactory } from './common/http/integration-http-client.factory';

/**
 * IntegrationsModule — Fase INT-1: infraestructura transversal de
 * integraciones con sistemas externos (Maximo, SAP).
 *
 * - SOLO LECTURA: el cliente HTTP que exporta únicamente sabe hacer GET.
 * - Sin controllers ni endpoints en esta fase.
 * - Sin lectura de env vars `MAXIMO_*` / `SL_*` (eso es de Int-2 / Int-3).
 * - No importa nada del dominio de Compras; el dominio tampoco importa de aquí.
 *
 * No es @Global a propósito: los futuros submódulos (maximo/, sap/) lo
 * importan explícitamente.
 */
@Module({
  providers: [IntegrationHttpClientFactory],
  exports: [IntegrationHttpClientFactory],
})
export class IntegrationsModule {}
