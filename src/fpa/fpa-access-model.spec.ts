/**
 * Modelo de acceso de FP&A (A3): a diferencia de Compras ("ver todos"), aquí
 * TODOS los handlers llevan @Roles, también los GET. Este spec lo pinza por
 * reflexión sobre la metadata real del controller, sin levantar la app:
 *  1) ningún handler queda sin @Roles;
 *  2) las lecturas son de los cuatro roles que entran al módulo;
 *  3) el CFO nunca escribe; las líneas las escriben fpa_area y planeación;
 *  4) áreas y responsables son solo de planeación (y super_admin);
 *  5) B2: el detalle de una versión lo ve quien ve todo (planeación y CFO) y
 *     la cambia solo planeación (alta, parámetros, visto bueno, abrir,
 *     regresar, cerrar y reabrir); los firmantes son de planeación;
 *  6) B3: en el flujo, enviar y retirar son de quien captura (fpa_area o
 *     planeación, si captura un área); aprobar y rechazar, de los cuatro
 *     roles (el CFO decide su paso); reabrir, de planeación. El turno lo
 *     resuelve el service.
 * El alcance por área (qué presupuesto ve o edita cada quien) lo cubre
 * fpa.service.spec.ts.
 */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { FpaController } from './fpa.controller';
import { FPA_ADMIN, FPA_EDITORS, FPA_ROLES, FPA_SEE_ALL } from './fpa-roles';

interface RouteInfo {
  method: string;
  route: string;
  roles: string[] | undefined;
}

function collectRoutes(): RouteInfo[] {
  const prefix = Reflect.getMetadata(PATH_METADATA, FpaController) as string;
  const proto = FpaController.prototype as unknown as Record<string, unknown>;
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

const ADMIN_ROUTES = [
  '/fpa/areas',
  '/fpa/responsables',
  '/fpa/usuarios/directorio',
  '/fpa/firmantes',
];

const VERSION_DETAIL = '/fpa/versiones/:id';

/** B3: aprobar y rechazar (el CFO decide su paso). */
const DECIDE = [
  '/fpa/presupuestos/:id/aprobar',
  '/fpa/presupuestos/:id/rechazar',
];

describe('FP&A — modelo de acceso del controller', () => {
  const routes = collectRoutes();

  it('encuentra los endpoints del lunes y la vista previa del cálculo', () => {
    const keys = routes.map((r) => `${r.method} ${r.route}`).sort();
    expect(keys).toEqual(
      [
        'GET /fpa/contexto',
        'GET /fpa/versiones',
        'GET /fpa/catalogo',
        'GET /fpa/presupuestos',
        'GET /fpa/presupuestos/:id',
        'POST /fpa/presupuestos/:id/lineas',
        'PUT /fpa/lineas/:id',
        'POST /fpa/lineas/:id/baja',
        'POST /fpa/calcular',
        'GET /fpa/consolidado',
        'GET /fpa/consolidado/export',
        'GET /fpa/areas',
        'POST /fpa/areas',
        'POST /fpa/responsables',
        'GET /fpa/usuarios/directorio',
        'GET /fpa/firmantes',
        'POST /fpa/firmantes',
        'GET /fpa/versiones/:id',
        'POST /fpa/versiones',
        'PUT /fpa/versiones/:id',
        'PUT /fpa/versiones/:id/parametros',
        'POST /fpa/versiones/:id/visto-bueno',
        'POST /fpa/versiones/:id/abrir',
        'POST /fpa/versiones/:id/regresar',
        'POST /fpa/versiones/:id/cerrar',
        'POST /fpa/versiones/:id/reabrir',
        'GET /fpa/pendientes',
        'GET /fpa/presupuestos/:id/flujo',
        'POST /fpa/presupuestos/:id/enviar',
        'POST /fpa/presupuestos/:id/aprobar',
        'POST /fpa/presupuestos/:id/rechazar',
        'POST /fpa/presupuestos/:id/retirar',
        'POST /fpa/presupuestos/:id/reabrir',
      ].sort(),
    );
  });

  it('ningún handler queda sin @Roles (tampoco los GET)', () => {
    const open = routes.filter((r) => !r.roles || r.roles.length === 0);
    expect(open).toEqual([]);
  });

  it('las lecturas del módulo son de los cuatro roles que entran', () => {
    const reads = routes.filter(
      (r) =>
        r.method === 'GET' &&
        !ADMIN_ROUTES.includes(r.route) &&
        r.route !== VERSION_DETAIL,
    );
    for (const r of reads) {
      expect([...(r.roles ?? [])].sort()).toEqual([...FPA_ROLES].sort());
    }
  });

  it('la vista previa del cálculo es de quien captura (B1)', () => {
    const calc = routes.find((r) => r.route === '/fpa/calcular');
    expect([...(calc?.roles ?? [])].sort()).toEqual([...FPA_EDITORS].sort());
  });

  it('el CFO solo decide su paso del flujo y las líneas las escriben fpa_area y planeación', () => {
    const writes = routes.filter((r) => r.method !== 'GET');
    for (const r of writes.filter((w) => !DECIDE.includes(w.route))) {
      expect(r.roles).not.toContain('fpa_cfo');
    }
    const lineWrites = writes.filter((r) => r.route.includes('lineas'));
    expect(lineWrites).toHaveLength(3);
    for (const r of lineWrites) {
      expect([...(r.roles ?? [])].sort()).toEqual([...FPA_EDITORS].sort());
    }
  });

  it('el detalle de una versión es de quien ve todo; cambiarla, de planeación (B2)', () => {
    const detail = routes.find(
      (r) => r.method === 'GET' && r.route === VERSION_DETAIL,
    );
    expect([...(detail?.roles ?? [])].sort()).toEqual([...FPA_SEE_ALL].sort());
    const writes = routes.filter(
      (r) => r.method !== 'GET' && r.route.startsWith('/fpa/versiones'),
    );
    expect(writes).toHaveLength(8);
    for (const r of writes) {
      expect([...(r.roles ?? [])].sort()).toEqual([...FPA_ADMIN].sort());
    }
  });

  it('el flujo (B3): enviar y retirar de quien captura, decidir de los cuatro roles, reabrir de planeación', () => {
    const roleOf = (route: string) =>
      [
        ...(routes.find((r) => r.method === 'POST' && r.route === route)
          ?.roles ?? []),
      ].sort();
    expect(roleOf('/fpa/presupuestos/:id/enviar')).toEqual(
      [...FPA_EDITORS].sort(),
    );
    expect(roleOf('/fpa/presupuestos/:id/retirar')).toEqual(
      [...FPA_EDITORS].sort(),
    );
    for (const route of DECIDE) {
      expect(roleOf(route)).toEqual([...FPA_ROLES].sort());
    }
    expect(roleOf('/fpa/presupuestos/:id/reabrir')).toEqual(
      [...FPA_ADMIN].sort(),
    );
  });

  it('áreas, responsables, firmantes y directorio son solo de planeación y super_admin', () => {
    const admin = routes.filter((r) => ADMIN_ROUTES.includes(r.route));
    expect(admin).toHaveLength(6);
    for (const r of admin) {
      expect([...(r.roles ?? [])].sort()).toEqual([...FPA_ADMIN].sort());
    }
  });
});
