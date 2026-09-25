/**
 * Modelo de acceso de Compras — "ver todos, actuar por rol" (junta
 * 2026-09-17): los GET de consulta van sin @Roles (RolesGuard deja pasar a
 * cualquier autenticado, precedente §15 Contratos) y TODA mutación conserva
 * roles estrictos.
 *
 * Este spec pinza ese contrato por reflexión sobre la metadata real de los
 * 12 controllers de compras, sin levantar la app:
 *  1) Ninguna mutación (POST/PUT/DELETE/PATCH) puede quedar sin @Roles.
 *  2) La lista de GETs abiertos es EXACTA: abrir (u olvidar abrir) un GET
 *     sin actualizar la lista blanca rompe el spec a propósito.
 *  3) Las bandejas personales y la configuración siguen restringidas.
 */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from './common/decorators/roles.decorator';
import { resolveRoleManagementScope } from './auth/auth.controller';
import { ApprovalsController } from './approvals/approvals.controller';
import { RequisitionsController } from './requisitions/requisitions.controller';
import { SuppliersController } from './suppliers/suppliers.controller';
import { PurchaseOrdersController } from './purchase-orders/purchase-orders.controller';
import { ExpeditingController } from './expediting/expediting.controller';
import { PurchaseCommitteesController } from './purchase-committees/purchase-committees.controller';
import { PurchaseReportsController } from './purchase-reports/purchase-reports.controller';
import { MaximoRecordsController } from './maximo-records/maximo-records.controller';
import { SapRecordsController } from './sap-records/sap-records.controller';
import { PurchaseTypesController } from './purchase-types/purchase-types.controller';
import { PurchaseUsersController } from './purchase-users/purchase-users.controller';
import { ContractsController } from './contracts/contracts.controller';
import { PurchaseDashboardController } from './purchase-dashboard/purchase-dashboard.controller';
import { ErpAliasesController } from './erp-aliases/erp-aliases.controller';

const PURCHASE_CONTROLLERS = [
  ApprovalsController,
  RequisitionsController,
  SuppliersController,
  PurchaseOrdersController,
  ExpeditingController,
  PurchaseCommitteesController,
  PurchaseReportsController,
  MaximoRecordsController,
  SapRecordsController,
  PurchaseTypesController,
  PurchaseUsersController,
  ContractsController,
  PurchaseDashboardController,
  ErpAliasesController,
];

interface RouteInfo {
  method: string;
  route: string;
  roles: string[] | undefined;
}

/** Recolecta método HTTP, ruta completa y roles de cada handler. */
function collectRoutes(): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const ctrl of PURCHASE_CONTROLLERS) {
    const prefix = Reflect.getMetadata(PATH_METADATA, ctrl) as string;
    const proto = ctrl.prototype as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name] as object;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        | number
        | undefined;
      if (method === undefined) continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
      const route = `/${prefix}/${path}`
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');
      routes.push({
        method: RequestMethod[method],
        route,
        roles: Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined,
      });
    }
  }
  return routes;
}

/**
 * Lista blanca EXACTA de GETs de solo lectura abiertos a cualquier
 * autenticado. Si abres o cierras un GET, este arreglo debe cambiar en el
 * mismo commit — es la decisión de seguridad quedando explícita en el diff.
 */
const OPEN_READS = [
  // Sprint 2026-09-22: resumen agregado, exports (B1) y cola SAP (B5)
  '/compras/dashboard/summary',
  '/sap/purchase-orders/export',
  '/sap/purchase-requests/export',
  '/sap/approval-requests',
  '/maximo/purchase-orders/export',
  '/maximo/contracts/export',
  '/compras/contratos/export',
  '/suppliers/export',
  // 2026-09-23: reporte semanal de Compras (Excel)
  '/compras/reportes/semanal/export',
  // Bloque 2026-09-23: KPIs de Órdenes (D5) y export de expeditación (D9)
  '/compras/dashboard/ordenes-kpis',
  '/compras/expeditacion/export',
  // 2026-09-25 (E1): valores por columna del filtro "tipo Excel"
  '/compras/expeditacion/facets',
  '/sap/purchase-orders/facets',
  '/sap/purchase-requests/facets',
  '/maximo/purchase-orders/facets',
  '/maximo/contracts/facets',
  '/compras/contratos/facets',
  '/suppliers/facets',
  '/approvals/requisition/:rqId',
  '/approvals/stats',
  '/requisitions',
  '/requisitions/stats',
  '/requisitions/:id',
  '/requisitions/:id/history',
  '/suppliers',
  '/suppliers/:id',
  '/suppliers/:id/performance',
  '/suppliers/:id/purchase-orders',
  '/purchase-orders',
  '/purchase-orders/stats',
  '/purchase-orders/:id',
  '/purchase-orders/requisition/:rqId',
  '/compras/expeditacion',
  '/compras/expeditacion/stats',
  '/compras/expeditacion/:poId',
  '/compras/comite',
  '/compras/comite/dashboard/tiempos',
  '/compras/comite/:id',
  '/compras/comite/:id/versions/:versionId/download',
  '/compras/reportes/resumen',
  '/compras/reportes/requisiciones',
  '/compras/reportes/ordenes',
  '/compras/reportes/aprobaciones',
  '/compras/reportes/entregas',
  '/compras/reportes/contratos',
  '/compras/reportes/comite',
  '/compras/reportes/maximo',
  '/compras/reportes/ahorro',
  '/compras/reportes/erp',
  '/compras/reportes/tiempos-aprobacion',
  '/maximo/summary',
  '/maximo/purchase-orders',
  '/maximo/purchase-orders/:ponum',
  '/maximo/contracts',
  '/maximo/contracts/:key',
  '/sap/summary',
  '/sap/purchase-orders',
  '/sap/purchase-orders/:docEntry',
  '/sap/purchase-requests',
  '/sap/purchase-requests/:docEntry',
  '/purchase-types',
  '/purchase-types/:id',
  '/compras/contratos',
  '/compras/contratos/:id',
  '/compras/contratos/:id/documents/:docId/download',
].sort();

describe('Modelo de acceso de Compras (ver todos, actuar por rol)', () => {
  const routes = collectRoutes();

  it('cubre los 13 controllers de compras (sanity)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(98);
  });

  it('NINGUNA mutación queda sin @Roles (un no-rol no puede mutar)', () => {
    const openMutations = routes.filter(
      (r) => r.method !== 'GET' && (!r.roles || r.roles.length === 0),
    );
    expect(openMutations).toEqual([]);
  });

  it('los GET abiertos son EXACTAMENTE la lista blanca', () => {
    const openGets = routes
      .filter((r) => r.method === 'GET' && (!r.roles || r.roles.length === 0))
      .map((r) => r.route)
      .sort();
    expect(openGets).toEqual(OPEN_READS);
  });

  it('las bandejas personales y la configuración siguen restringidas', () => {
    const restricted = [
      '/approvals/pending',
      '/approvals/my-approvals',
      '/compras/comite/pendientes/me',
      '/compras/comite/niveles',
      '/compras/usuarios/gestion',
      '/compras/usuarios',
      '/compras/contratos/alertas/vencimiento',
      // D6: equivalencias de usuarios SAP/Maximo = configuración
      '/compras/erp-aliases',
    ];
    for (const route of restricted) {
      const info = routes.find((r) => r.method === 'GET' && r.route === route);
      expect(info).toBeDefined();
      expect(info?.roles?.length).toBeGreaterThan(0);
    }
  });

  it('el apartado de gestión de roles es solo de super_admin/lider_procura', () => {
    const info = routes.find(
      (r) => r.method === 'GET' && r.route === '/compras/usuarios/gestion',
    );
    expect(info?.roles).toEqual(['super_admin', 'lider_procura']);
  });
});

describe('resolveRoleManagementScope (alcance del actor)', () => {
  it('super_admin no tiene restricción', () => {
    expect(resolveRoleManagementScope(['super_admin'])).toEqual({});
    expect(
      resolveRoleManagementScope(['super_admin', 'lider_procura']),
    ).toEqual({});
  });

  it('admin_rh solo gestiona capacitación (como siempre)', () => {
    expect(resolveRoleManagementScope(['admin_rh'])).toEqual({
      allowedModules: ['capacitacion'],
      allowedRoles: ['colaborador', 'jefe_area'],
    });
  });

  it('lider_procura solo gestiona compras y NO puede otorgar lider_procura', () => {
    const scope = resolveRoleManagementScope(['lider_procura']);
    expect(scope.allowedModules).toEqual(['compras']);
    expect(scope.allowedRoles).toEqual([
      'solicitante',
      'comprador',
      'coordinador_compras',
      'aprobador_nivel_1',
      'aprobador_nivel_2',
      'aprobador_nivel_3',
      'director_general',
    ]);
    expect(scope.allowedRoles).not.toContain('lider_procura');
    expect(scope.allowedRoles).not.toContain('super_admin');
  });

  it('roles gestores se suman (admin_rh + lider_procura)', () => {
    const scope = resolveRoleManagementScope(['admin_rh', 'lider_procura']);
    expect(scope.allowedModules).toEqual(['capacitacion', 'compras']);
    expect(scope.allowedRoles).toContain('colaborador');
    expect(scope.allowedRoles).toContain('comprador');
  });

  it('un actor sin rol gestor no puede tocar nada', () => {
    const scope = resolveRoleManagementScope(['comprador']);
    expect(scope.allowedModules).toEqual([]);
    expect(scope.allowedRoles).toEqual([]);
  });
});
