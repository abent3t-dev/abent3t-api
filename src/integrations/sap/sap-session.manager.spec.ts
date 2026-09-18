import { SapSessionManager } from './sap-session.manager';
import { SapNotConfiguredError } from './sap.errors';
import type { SapConfig } from './sap.config';

/**
 * Fase INT-4. Gestor de sesión (T2) — login mockeado, sin red. Cubre: cache
 * de cookie, renovación por expiración, invalidate tras 401, colapso de
 * logins concurrentes y el fail-fast sin configuración.
 */

const CONFIG: SapConfig = {
  baseUrl: 'https://sap.test:50000/b1s/v2',
  companyDb: 'TEST_DB',
  user: 'usuario',
  password: 'secreto',
  rejectUnauthorized: false,
  timeoutMs: 1_000,
  maxRetries: 0,
};

function makeManager(overrides: Partial<SapConfig> = {}) {
  let nowMs = 1_000_000;
  const loginFn = jest.fn().mockResolvedValue({
    cookieHeader: 'B1SESSION=abc; ROUTEID=.node1',
    sessionTimeoutMinutes: 30,
  });
  const manager = new SapSessionManager(
    { ...CONFIG, ...overrides },
    { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    loginFn,
    () => nowMs,
  );
  return { manager, loginFn, advance: (ms: number) => (nowMs += ms) };
}

describe('SapSessionManager', () => {
  it('cachea la cookie: dos llamadas seguidas = un solo login', async () => {
    const { manager, loginFn } = makeManager();
    const first = await manager.getCookieHeader();
    const second = await manager.getCookieHeader();
    expect(first).toBe('B1SESSION=abc; ROUTEID=.node1');
    expect(second).toBe(first);
    expect(loginFn).toHaveBeenCalledTimes(1);
    // el password viaja al login pero jamás en la cookie devuelta
    expect(first).not.toContain('secreto');
  });

  it('re-loguea cuando la sesión está por expirar (margen de 5 min sobre 30)', async () => {
    const { manager, loginFn, advance } = makeManager();
    await manager.getCookieHeader();
    advance(24 * 60_000); // aún dentro de los 25 min útiles
    await manager.getCookieHeader();
    expect(loginFn).toHaveBeenCalledTimes(1);
    advance(2 * 60_000); // 26 min: pasó el corte de 30-5
    await manager.getCookieHeader();
    expect(loginFn).toHaveBeenCalledTimes(2);
  });

  it('invalidate() fuerza re-login en la siguiente llamada (patrón 401)', async () => {
    const { manager, loginFn } = makeManager();
    await manager.getCookieHeader();
    manager.invalidate();
    await manager.getCookieHeader();
    expect(loginFn).toHaveBeenCalledTimes(2);
  });

  it('invalidate(cookieVieja) NO tumba una sesión ya renovada por otra corrida', async () => {
    const { manager, loginFn } = makeManager();
    const vieja = await manager.getCookieHeader();
    manager.invalidate(); // corrida A renueva
    loginFn.mockResolvedValueOnce({
      cookieHeader: 'B1SESSION=fresca',
      sessionTimeoutMinutes: 30,
    });
    const fresca = await manager.getCookieHeader();
    expect(fresca).toBe('B1SESSION=fresca');
    // Corrida B llega tarde con su 401 de la cookie vieja: no-op
    manager.invalidate(vieja);
    await manager.getCookieHeader();
    expect(loginFn).toHaveBeenCalledTimes(2); // sin re-login extra
  });

  it('llamadas concurrentes sin sesión colapsan en UN login', async () => {
    const { manager, loginFn } = makeManager();
    const [a, b, c] = await Promise.all([
      manager.getCookieHeader(),
      manager.getCookieHeader(),
      manager.getCookieHeader(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(loginFn).toHaveBeenCalledTimes(1);
  });

  it('sin credenciales → SapNotConfiguredError nombrando las variables, sin tocar el login', async () => {
    const { manager, loginFn } = makeManager({ user: null, password: null });
    await expect(manager.getCookieHeader()).rejects.toThrow(
      SapNotConfiguredError,
    );
    await expect(manager.getCookieHeader()).rejects.toThrow(
      /SL_USER, SL_PASSWORD/,
    );
    expect(loginFn).not.toHaveBeenCalled();
  });

  it('un login fallido no deja sesión a medias: el siguiente intento re-loguea', async () => {
    const { manager, loginFn } = makeManager();
    loginFn.mockRejectedValueOnce(new Error('Tenant does not exist'));
    await expect(manager.getCookieHeader()).rejects.toThrow(
      'Tenant does not exist',
    );
    await expect(manager.getCookieHeader()).resolves.toContain('B1SESSION=');
    expect(loginFn).toHaveBeenCalledTimes(2);
  });
});
