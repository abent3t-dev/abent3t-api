import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { PurchaseUsersService } from './purchase-users.service';
import { PaginationDto } from '../common/dto/pagination.dto';

// Roles de compras (§Roles y Permisos)
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];
const APPROVERS = [
  'aprobador_nivel_1',
  'aprobador_nivel_2',
  'aprobador_nivel_3',
  'director_general',
];
// Gestión de roles de compras (autoservicio): solo el líder de procura
// (super_admin bypassa RolesGuard).
const PURCHASE_ROLE_MANAGERS = ['super_admin', 'lider_procura'];

/** Fase §16 (T7) — GET /compras/usuarios: directorio para selects de compras. */
@Controller('compras/usuarios')
export class PurchaseUsersController {
  constructor(private readonly service: PurchaseUsersService) {}

  /**
   * Listado para el apartado de gestión de roles de Compras (junta
   * 2026-09-17). Ruta literal declarada antes que las genéricas
   * (convención del repo).
   */
  @Roles(...PURCHASE_ROLE_MANAGERS)
  @Get('gestion')
  findAllForRoleManagement(@Query() pagination: PaginationDto) {
    return this.service.findAllForRoleManagement(
      pagination.page ?? 1,
      pagination.limit ?? 20,
      pagination.search,
    );
  }

  @Roles(...PURCHASE_TEAM, ...APPROVERS)
  @Get()
  findAll(@Query('role') role?: string) {
    return this.service.findAll(role);
  }
}
