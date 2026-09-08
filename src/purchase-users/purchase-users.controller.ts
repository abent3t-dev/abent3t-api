import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { PurchaseUsersService } from './purchase-users.service';

// Roles de compras (§Roles y Permisos)
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];
const APPROVERS = [
  'aprobador_nivel_1',
  'aprobador_nivel_2',
  'aprobador_nivel_3',
  'director_general',
];

/** Fase §16 (T7) — GET /compras/usuarios: directorio para selects de compras. */
@Controller('compras/usuarios')
export class PurchaseUsersController {
  constructor(private readonly service: PurchaseUsersService) {}

  @Roles(...PURCHASE_TEAM, ...APPROVERS)
  @Get()
  findAll(@Query('role') role?: string) {
    return this.service.findAll(role);
  }
}
