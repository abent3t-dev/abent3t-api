// Almacén (0026; rol aprobado por Alex el 2026-11-23). Un solo rol, de
// consulta: entra al módulo y ve el reporte de inventario al corte. Cargar un
// corte no es de ningún rol: lo hace `npm run almacen:cargar` en un contenedor
// efímero (documentation/ALMACEN.md).

/** Entran al módulo y leen. */
export const ALMACEN_ROLES = ['super_admin', 'almacen_consulta'];

/** Roles del módulo almacen en user_roles. */
export const ALMACEN_MODULE_ROLES = ['almacen_consulta'];
