import { Injectable } from '@nestjs/common';
import { IntegrationHttpClient } from './integration-http.client';
import { IntegrationHttpClientConfig } from './integration-http.types';

/**
 * Factory inyectable: cada sistema externo (Maximo en Int-2, SAP en Int-4)
 * crea su propia instancia de `IntegrationHttpClient` con su baseUrl,
 * timeouts y headers. La configuración (env vars `MAXIMO_*` / `SL_*`) la
 * resuelve el submódulo consumidor — esta fase no lee ninguna.
 */
@Injectable()
export class IntegrationHttpClientFactory {
  create(config: IntegrationHttpClientConfig): IntegrationHttpClient {
    return new IntegrationHttpClient(config);
  }
}
