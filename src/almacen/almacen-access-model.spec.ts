/**
 * Modelo de acceso de Almacén (0026): como en FP&A, TODOS los handlers llevan
 * @Roles, también los GET, y solo entran super_admin y almacen_consulta. Este
 * spec lo pinza por reflexión sobre la metadata real del controller, sin
 * levantar la app. El módulo es de solo lectura: no hay rutas que escriban.
 */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import {
  ROLE_PRIORITY,
  ROLE_TO_MODULE,
} from '../common/services/user-roles.helper';
import { ALMACEN_MODULE_ROLES, ALMACEN_ROLES } from './almacen-roles';
import { AlmacenController } from './almacen.controller';

interface RouteInfo {
  method: string;
  route: string;
  roles: string[] | undefined;
}

function collectRoutes(): RouteInfo[] {
  const prefix = Reflect.getMetadata(
    PATH_METADATA,
    AlmacenController,
  ) as string;
  const proto = AlmacenController.prototype as unknown as Record<
    string,
    unknown
  >;
  const routes: RouteInfo[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const handler = proto[name] as object;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as
      | number
      | undefined;
    if (method === undefined) continue;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
    routes.push({
      method: RequestMethod[method],
      route: `/${prefix}/${path}`.replace(/\/+/g, '/').replace(/\/$/, ''),
      roles: Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined,
    });
  }
  return routes;
}

describe('Almacén — modelo de acceso del controller', () => {
  const routes = collectRoutes();

  it('encuentra las cinco rutas de consulta, todas GET', () => {
    expect(routes.map((r) => `${r.method} ${r.route}`).sort()).toEqual([
      'GET /almacen/cortes',
      'GET /almacen/cortes/:id',
      'GET /almacen/cortes/:id/devoluciones',
      'GET /almacen/cortes/:id/excel',
      'GET /almacen/cortes/:id/existencias',
    ]);
  });

  it('ninguna ruta queda sin @Roles', () => {
    expect(routes.filter((r) => !r.roles?.length).map((r) => r.route)).toEqual(
      [],
    );
  });

  it('solo entran super_admin y almacen_consulta', () => {
    for (const r of routes)
      expect([...r.roles!].sort()).toEqual(['almacen_consulta', 'super_admin']);
    expect([...ALMACEN_ROLES].sort()).toEqual([
      'almacen_consulta',
      'super_admin',
    ]);
  });

  it('el rol queda registrado en el módulo almacen y al final de la prioridad', () => {
    for (const r of ALMACEN_MODULE_ROLES)
      expect(ROLE_TO_MODULE[r]).toBe('almacen');
    expect(ROLE_PRIORITY[ROLE_PRIORITY.length - 1]).toBe('almacen_consulta');
    // Nadie con otro rol pierde su rol principal por tener también el de almacén
    expect(ROLE_PRIORITY.indexOf('almacen_consulta')).toBeGreaterThan(
      ROLE_PRIORITY.indexOf('colaborador'),
    );
  });
});
