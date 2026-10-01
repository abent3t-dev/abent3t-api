import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { EmailOutboxController } from './email-outbox.controller';
import type { EmailOutboxService } from './email-outbox.service';

/**
 * J1 (2026-10-01) — Mínimo privilegio en la bitácora de correo: ningún
 * handler queda abierto a cualquier autenticado (RolesGuard deja pasar los
 * que no tienen @Roles) y solo super_admin pausa o reanuda el envío.
 */

function routes() {
  const proto = EmailOutboxController.prototype as unknown as Record<
    string,
    object
  >;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = proto[name];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      return {
        route: `${RequestMethod[method]} /correo/${Reflect.getMetadata(PATH_METADATA, handler) as string}`,
        roles: Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined,
      };
    });
}

describe('EmailOutboxController (J1)', () => {
  it('cada ruta tiene roles explícitos', () => {
    expect(Object.fromEntries(routes().map((r) => [r.route, r.roles]))).toEqual(
      {
        'GET /correo/estado': ['super_admin', 'lider_procura', 'admin_rh'],
        'GET /correo/bitacora': ['super_admin', 'lider_procura', 'admin_rh'],
        'GET /correo/bitacora/:id': [
          'super_admin',
          'lider_procura',
          'admin_rh',
        ],
        'PUT /correo/pausa': ['super_admin'],
      },
    );
  });

  it('la pausa registra quién la puso y el motivo', async () => {
    const setPaused = jest.fn(() => Promise.resolve({ state: 'pausado' }));
    const controller = new EmailOutboxController({
      setPaused,
    } as unknown as EmailOutboxService);

    await controller.pause(
      { paused: true, motivo: 'Revisión con TI' },
      { id: 'u-1' },
    );
    expect(setPaused).toHaveBeenCalledWith(true, 'u-1', 'Revisión con TI');
  });
});
