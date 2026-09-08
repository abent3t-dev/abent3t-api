import { Test } from '@nestjs/testing';
import { IntegrationHttpClientFactory } from './common/http/integration-http-client.factory';
import { IntegrationHttpClient } from './common/http/integration-http.client';
import { IntegrationsModule } from './integrations.module';

/**
 * Fase INT-1: el módulo compila en el contenedor de Nest sin dependencias
 * externas (ni ConfigService, ni Prisma, ni red) y exporta la factory.
 */
describe('IntegrationsModule', () => {
  it('compila, exporta IntegrationHttpClientFactory y no registra controllers', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationsModule],
    }).compile();

    const factory = moduleRef.get(IntegrationHttpClientFactory);
    expect(factory).toBeInstanceOf(IntegrationHttpClientFactory);

    const client = factory.create({
      system: 'maximo',
      baseUrl: 'http://maximo.test/maxrest/rest/os',
    });
    expect(client).toBeInstanceOf(IntegrationHttpClient);

    await moduleRef.close();
  });
});
