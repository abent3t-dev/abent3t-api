import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MaximoClient } from './maximo.client';
import {
  loadMaximoConfig,
  MAXIMO_CONFIG,
  MAXIMO_DEFAULT_MAX_RETRIES,
  MAXIMO_DEFAULT_TIMEOUT_MS,
  MaximoConfig,
} from './maximo.config';
import { MaximoNotConfiguredError } from './maximo.errors';
import { MaximoModule } from './maximo.module';

/**
 * Fase INT-2: el módulo compila sin env vars de Maximo (dev), no toca la red y
 * solo lee las variables permitidas. Los valores son ficticios de test.
 */
const stubConfigService = (values: Record<string, unknown>): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('loadMaximoConfig', () => {
  it('vacíos → null; booleano de Joi o string "true" → contractsEnabled', () => {
    expect(loadMaximoConfig(stubConfigService({}))).toEqual<MaximoConfig>({
      baseUrl: null,
      oslcUrl: null,
      authToken: null,
      contractsEnabled: false,
      timeoutMs: MAXIMO_DEFAULT_TIMEOUT_MS,
      maxRetries: MAXIMO_DEFAULT_MAX_RETRIES,
    });
    expect(
      loadMaximoConfig(
        stubConfigService({
          MAXIMO_BASE_URL: ' http://maximo.test/maxrest/rest/os ',
          MAXIMO_OSLC_URL: '',
          MAXIMO_AUTH_TOKEN: 'fake',
          MAXIMO_CONTRACTS_ENABLED: true,
        }),
      ),
    ).toMatchObject({
      baseUrl: 'http://maximo.test/maxrest/rest/os',
      oslcUrl: null,
      authToken: 'fake',
      contractsEnabled: true,
    });
    expect(
      loadMaximoConfig(stubConfigService({ MAXIMO_CONTRACTS_ENABLED: 'true' }))
        .contractsEnabled,
    ).toBe(true);
    expect(
      loadMaximoConfig(stubConfigService({ MAXIMO_CONTRACTS_ENABLED: 'si' }))
        .contractsEnabled,
    ).toBe(false);
  });

  it('no lee la bandera de sincronización MAXIMO_SYNC_* (es de Int-3)', () => {
    const asked: string[] = [];
    const spy = {
      get: (key: string) => {
        asked.push(key);
        return undefined;
      },
    } as unknown as ConfigService;
    loadMaximoConfig(spy);
    // Nombre compuesto a propósito: el criterio de aceptación se verifica con grep.
    expect(asked).not.toContain(['MAXIMO_SYNC', 'ENABLED'].join('_'));
    expect(asked.sort()).toEqual([
      'MAXIMO_AUTH_TOKEN',
      'MAXIMO_BASE_URL',
      'MAXIMO_CONTRACTS_ENABLED',
      'MAXIMO_OSLC_URL',
    ]);
  });
});

describe('MaximoModule', () => {
  it('compila sin MAXIMO_* configuradas y el cliente falla tipado sin red', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MaximoModule],
    })
      .overrideProvider(ConfigService)
      .useValue(stubConfigService({ MAXIMO_CONTRACTS_ENABLED: false }))
      .compile();

    const config = moduleRef.get<MaximoConfig>(MAXIMO_CONFIG);
    expect(config.baseUrl).toBeNull();
    expect(config.contractsEnabled).toBe(false);

    const client = moduleRef.get(MaximoClient);
    expect(client).toBeInstanceOf(MaximoClient);
    await expect(client.fetchPurchaseOrders()).rejects.toBeInstanceOf(
      MaximoNotConfiguredError,
    );

    await moduleRef.close();
  });
});
