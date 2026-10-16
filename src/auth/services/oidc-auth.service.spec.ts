import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from 'jose';
import { OIDCAuthService, oidcFailureCode } from './oidc-auth.service';
import type { AuthEventsService } from './auth-events.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Motivo del rechazo en el callback de Microsoft (2026-10-16): César no veía
 * por qué fallaba el login (Rodrigo no tenía perfil) porque todo salía como
 * `oidc_failed`. Ahora cada rechazo lleva su código para `/login?error=`.
 * El id_token se firma aquí con una llave local; `fetch` es falso (cero red).
 */

const ISSUER = 'https://login.microsoftonline.com/tenant-test/v2.0';
const CLIENT_ID = 'client-test';
const NONCE = 'nonce-test';

describe('OIDCAuthService.handleCallback: motivo del rechazo', () => {
  const realFetch = global.fetch;
  const envBackup = { ...process.env };
  let fetchMock: jest.Mock;
  let findFirst: jest.Mock;
  let service: OIDCAuthService;
  let sign: (claims: JWTPayload) => Promise<string>;

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const jwks = createLocalJWKSet({ keys: [jwk] });
    sign = (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

    process.env.AZURE_AD_TENANT_ID = 'tenant-test';
    process.env.AZURE_AD_CLIENT_ID = CLIENT_ID;
    process.env.AZURE_AD_CLIENT_SECRET = 'secret-test';
    process.env.AZURE_AD_REDIRECT_URI =
      'https://dashboard.example.com/api/auth/callback';
    process.env.ALLOWED_EMAIL_DOMAIN = 'abent3t.com';

    findFirst = jest.fn();
    const prisma = {
      profiles: { findFirst, update: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const authEvents = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuthEventsService;
    service = new OIDCAuthService(authEvents, prisma);
    // Discovery y JWKS ya resueltos: la prueba no sale a Microsoft
    Object.assign(service as unknown as Record<string, unknown>, {
      discovery: {
        issuer: ISSUER,
        authorization_endpoint: 'https://login.example.com/authorize',
        token_endpoint: 'https://login.example.com/token',
        jwks_uri: 'https://login.example.com/keys',
      },
      jwks,
    });
  });

  afterAll(() => {
    process.env = envBackup;
  });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    findFirst.mockReset();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  /** El canje del code devuelve un id_token con estos claims. */
  const tokenWith = async (claims: JWTPayload) => {
    const idToken = await sign({ nonce: NONCE, ...claims });
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id_token: idToken }),
    });
  };

  const failureOf = async () => {
    try {
      await service.handleCallback('code-test', NONCE);
    } catch (err) {
      return oidcFailureCode(err);
    }
    throw new Error('handleCallback debía rechazar');
  };

  it('perfil no registrado → oidc_no_profile', async () => {
    await tokenWith({ email: 'rodrigo.reyes@abent3t.com' });
    findFirst.mockResolvedValue(null);
    await expect(failureOf()).resolves.toBe('oidc_no_profile');
  });

  it('perfil desactivado → oidc_inactive', async () => {
    await tokenWith({ email: 'ana@abent3t.com' });
    findFirst.mockResolvedValue({
      id: 'p1',
      email: 'ana@abent3t.com',
      is_active: false,
    });
    await expect(failureOf()).resolves.toBe('oidc_inactive');
  });

  it('dominio no permitido → oidc_domain (sin buscar el perfil)', async () => {
    await tokenWith({ email: 'jorge@otro.com' });
    await expect(failureOf()).resolves.toBe('oidc_domain');
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('sin correo en el token → oidc_no_email', async () => {
    await tokenWith({});
    await expect(failureOf()).resolves.toBe('oidc_no_email');
  });

  it('falla el canje del code con Microsoft → oidc_failed', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('AADSTS7000222'),
    });
    await expect(failureOf()).resolves.toBe('oidc_failed');
  });

  it('nonce distinto (posible replay) → oidc_failed', async () => {
    await tokenWith({ email: 'ingrid@abent3t.com', nonce: 'otro' });
    findFirst.mockResolvedValue({
      id: 'p2',
      email: 'ingrid@abent3t.com',
      is_active: true,
    });
    await expect(failureOf()).resolves.toBe('oidc_failed');
  });

  it('perfil activo → entra', async () => {
    await tokenWith({ email: 'Ingrid@Abent3t.com' });
    findFirst.mockResolvedValue({
      id: 'p2',
      email: 'ingrid@abent3t.com',
      is_active: true,
    });
    await expect(service.handleCallback('code-test', NONCE)).resolves.toEqual({
      profileId: 'p2',
      email: 'ingrid@abent3t.com',
    });
  });

  it('un error que no viene del callback → oidc_failed', () => {
    expect(oidcFailureCode(new Error('x'))).toBe('oidc_failed');
    expect(oidcFailureCode('texto')).toBe('oidc_failed');
    expect(oidcFailureCode(undefined)).toBe('oidc_failed');
  });
});
