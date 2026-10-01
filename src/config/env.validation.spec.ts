import { envValidationSchema, envValidationOptions } from './env.validation';

/**
 * Fase 0 — T1: el schema se valida directamente (no hace falta levantar la
 * app entera por caso). Los valores son ficticios de test, no secretos reales.
 */
describe('envValidationSchema', () => {
  const baseEnv: Record<string, string> = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5433/db?schema=public',
    JWT_SECRET: 'test-jwt-secret',
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_PORT: '9000',
    MINIO_USE_SSL: 'false',
    MINIO_ACCESS_KEY: 'test-access-key',
    MINIO_SECRET_KEY: 'test-secret-key',
    MINIO_BUCKET_EVIDENCES: 'evidences',
    MINIO_BUCKET_PROPOSALS: 'proposal-attachments',
    PLATFORM_ENCRYPTION_KEY: 'x'.repeat(32),
  };

  const validate = (env: Record<string, string | undefined>) =>
    envValidationSchema.validate(env, envValidationOptions);

  it('acepta un entorno completo (arranque igual que antes)', () => {
    const { error } = validate(baseEnv);
    expect(error).toBeUndefined();
  });

  /** Copia del entorno base sin las variables indicadas. */
  const omit = (...keys: string[]): Record<string, string> => {
    const env = { ...baseEnv };
    for (const key of keys) delete env[key];
    return env;
  };

  it('falla sin JWT_SECRET y el error nombra la variable', () => {
    const { error } = validate(omit('JWT_SECRET'));
    expect(error).toBeDefined();
    expect(error!.message).toContain('JWT_SECRET');
  });

  it.each([
    'DATABASE_URL',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
    'PLATFORM_ENCRYPTION_KEY',
  ])('falla sin %s y el error nombra la variable', (name) => {
    const env = { ...baseEnv };
    delete env[name];
    const { error } = validate(env);
    expect(error).toBeDefined();
    expect(error!.message).toContain(name);
  });

  it('falla si PLATFORM_ENCRYPTION_KEY tiene menos de 32 caracteres', () => {
    const { error } = validate({
      ...baseEnv,
      PLATFORM_ENCRYPTION_KEY: 'demasiado-corta',
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('PLATFORM_ENCRYPTION_KEY');
  });

  it('MAXIMO_SYNC_ENABLED=true sin MAXIMO_AUTH_TOKEN falla al inicio', () => {
    const { error } = validate({
      ...baseEnv,
      MAXIMO_SYNC_ENABLED: 'true',
      MAXIMO_BASE_URL: 'http://maximo.example:9080/maxrest/rest/os',
      MAXIMO_OSLC_URL: 'http://maximo.example:9080/maximo/oslc/os',
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('MAXIMO_AUTH_TOKEN');
  });

  it('MAXIMO_SYNC_ENABLED=true con las tres variables presentes pasa', () => {
    const { error } = validate({
      ...baseEnv,
      MAXIMO_SYNC_ENABLED: 'true',
      MAXIMO_BASE_URL: 'http://maximo.example:9080/maxrest/rest/os',
      MAXIMO_OSLC_URL: 'http://maximo.example:9080/maximo/oslc/os',
      MAXIMO_AUTH_TOKEN: 'token-de-prueba',
    });
    expect(error).toBeUndefined();
  });

  it('MAXIMO_SYNC_ENABLED ausente (default false) no exige las MAXIMO_*', () => {
    const result = validate(baseEnv);
    expect(result.error).toBeUndefined();
    const value = result.value as Record<string, unknown>;
    expect(value.MAXIMO_SYNC_ENABLED).toBe(false);
  });

  it.each(['MAXIMO_BASE_URL', 'MAXIMO_OSLC_URL', 'MAXIMO_AUTH_TOKEN'])(
    'con el flag encendido, %s PRESENTE PERO VACÍA también falla (fail-fast, Int-3)',
    (name) => {
      const { error } = validate({
        ...baseEnv,
        MAXIMO_SYNC_ENABLED: 'true',
        MAXIMO_BASE_URL: 'http://maximo.example:9080/maxrest/rest/os',
        MAXIMO_OSLC_URL: 'http://maximo.example:9080/maximo/oslc/os',
        MAXIMO_AUTH_TOKEN: 'token-de-prueba',
        [name]: '',
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain(name);
    },
  );

  it('MAXIMO_CONTRACTS_ENABLED es booleano con default false (Fase INT-2)', () => {
    const asValues = (env: Record<string, string | undefined>) => {
      const result = validate(env);
      return {
        error: result.error,
        value: result.value as Record<string, unknown>,
      };
    };

    const byDefault = asValues(baseEnv);
    expect(byDefault.error).toBeUndefined();
    expect(byDefault.value.MAXIMO_CONTRACTS_ENABLED).toBe(false);

    const enabled = asValues({ ...baseEnv, MAXIMO_CONTRACTS_ENABLED: 'true' });
    expect(enabled.error).toBeUndefined();
    expect(enabled.value.MAXIMO_CONTRACTS_ENABLED).toBe(true);

    const invalid = asValues({ ...baseEnv, MAXIMO_CONTRACTS_ENABLED: 'si' });
    expect(invalid.error).toBeDefined();
    expect(invalid.error!.message).toContain('MAXIMO_CONTRACTS_ENABLED');
  });

  it('MAXIMO_SYNC_INTERVAL_MINUTES y MAXIMO_SYNC_PAGE_SIZE tienen defaults y límites (Fase INT-3)', () => {
    const defaults = validate(baseEnv);
    expect(defaults.error).toBeUndefined();
    const value = defaults.value as Record<string, unknown>;
    expect(value.MAXIMO_SYNC_INTERVAL_MINUTES).toBe(60);
    expect(value.MAXIMO_SYNC_PAGE_SIZE).toBe(100);

    expect(
      validate({ ...baseEnv, MAXIMO_SYNC_INTERVAL_MINUTES: '0' }).error,
    ).toBeDefined();
    // max 10080: por encima de ~35 791 min setInterval desbordaría (Int-3).
    expect(
      validate({ ...baseEnv, MAXIMO_SYNC_INTERVAL_MINUTES: '20000' }).error,
    ).toBeDefined();
    expect(
      validate({ ...baseEnv, MAXIMO_SYNC_INTERVAL_MINUTES: '10080' }).error,
    ).toBeUndefined();
    expect(
      validate({ ...baseEnv, MAXIMO_SYNC_PAGE_SIZE: '501' }).error,
    ).toBeDefined();
    expect(
      validate({ ...baseEnv, MAXIMO_SYNC_PAGE_SIZE: '250' }).error,
    ).toBeUndefined();
  });

  it('NODE_ENV=production + SL_REJECT_UNAUTHORIZED=false falla al inicio', () => {
    const { error } = validate({
      ...baseEnv,
      NODE_ENV: 'production',
      SL_REJECT_UNAUTHORIZED: 'false',
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SL_REJECT_UNAUTHORIZED');
  });

  it('SL_REJECT_UNAUTHORIZED=false se permite fuera de producción', () => {
    const { error } = validate({
      ...baseEnv,
      NODE_ENV: 'development',
      SL_REJECT_UNAUTHORIZED: 'false',
    });
    expect(error).toBeUndefined();
  });

  describe('correo (J1)', () => {
    /** Resultado con los valores ya convertidos (defaults incluidos). */
    const validated = (env: Record<string, string>) => {
      const result = validate(env);
      return {
        error: result.error,
        value: result.value as Record<string, unknown>,
      };
    };

    it('sin variables: simulación, ritmo de 120 s y tope de 100', () => {
      const { error, value } = validated(baseEnv);
      expect(error).toBeUndefined();
      expect(value).toMatchObject({
        EMAIL_TRANSPORT: 'simulacion',
        EMAIL_MIN_INTERVAL_SECONDS: 120,
        EMAIL_DAILY_CAP: 100,
      });
    });

    it('las credenciales de Azure solas NO habilitan el envío', () => {
      const { error, value } = validated({
        ...baseEnv,
        AZURE_TENANT_ID: 't',
        AZURE_CLIENT_ID: 'c',
        AZURE_CLIENT_SECRET: 's',
      });
      expect(error).toBeUndefined();
      expect(value.EMAIL_TRANSPORT).toBe('simulacion');
    });

    it('EMAIL_TRANSPORT=graph exige las tres variables de Azure', () => {
      const { error } = validate({
        ...baseEnv,
        EMAIL_TRANSPORT: 'graph',
        AZURE_TENANT_ID: 't',
        AZURE_CLIENT_SECRET: '',
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain('AZURE_CLIENT_ID');
      expect(error!.message).toContain('AZURE_CLIENT_SECRET');
      expect(error!.message).not.toContain('AZURE_TENANT_ID');
    });

    it('EMAIL_TRANSPORT=Graph con las tres variables pasa', () => {
      const { error, value } = validated({
        ...baseEnv,
        EMAIL_TRANSPORT: ' Graph ',
        AZURE_TENANT_ID: 't',
        AZURE_CLIENT_ID: 'c',
        AZURE_CLIENT_SECRET: 's',
      });
      expect(error).toBeUndefined();
      expect(value.EMAIL_TRANSPORT).toBe('graph');
    });

    it('EMAIL_TRANSPORT=smtp exige SMTP_HOST y EMAIL_FROM (J3)', () => {
      const { error } = validated({ ...baseEnv, EMAIL_TRANSPORT: 'smtp' });
      expect(error).toBeDefined();
      expect(error!.message).toContain('SMTP_HOST');
      expect(error!.message).toContain('EMAIL_FROM');
    });

    it('smtp con host y remitente pasa: puerto 587 y STARTTLS por defecto (J3)', () => {
      const { error, value } = validated({
        ...baseEnv,
        EMAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.relay.example',
        EMAIL_FROM: 'avisos@abent3t.com',
      });
      expect(error).toBeUndefined();
      expect(value).toMatchObject({
        EMAIL_TRANSPORT: 'smtp',
        SMTP_PORT: 587,
        SMTP_SECURE: false,
      });
    });

    it('SMTP_USER sin SMTP_PASS falla (J3)', () => {
      const { error } = validated({
        ...baseEnv,
        EMAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.relay.example',
        EMAIL_FROM: 'avisos@abent3t.com',
        SMTP_USER: 'relay-user',
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain('SMTP_PASS');
    });

    it('las variables SMTP solas tampoco habilitan el envío (J3)', () => {
      const { error, value } = validated({
        ...baseEnv,
        SMTP_HOST: 'smtp.relay.example',
        SMTP_USER: 'relay-user',
        SMTP_PASS: 'x',
      });
      expect(error).toBeUndefined();
      expect(value.EMAIL_TRANSPORT).toBe('simulacion');
    });

    it.each([
      ['EMAIL_TRANSPORT', 'sendgrid'],
      ['SMTP_PORT', '70000'],
      ['EMAIL_MIN_INTERVAL_SECONDS', '0'],
      ['EMAIL_DAILY_CAP', '-5'],
      ['EMAIL_FROM', 'no-es-correo'],
    ])('rechaza %s=%s', (name, bad) => {
      const { error } = validate({ ...baseEnv, [name]: bad });
      expect(error).toBeDefined();
      expect(error!.message).toContain(name);
    });
  });

  it('reporta TODAS las variables faltantes en un solo error (abortEarly=false)', () => {
    const { error } = validate(omit('JWT_SECRET', 'DATABASE_URL'));
    expect(error).toBeDefined();
    expect(error!.message).toContain('JWT_SECRET');
    expect(error!.message).toContain('DATABASE_URL');
  });
});
