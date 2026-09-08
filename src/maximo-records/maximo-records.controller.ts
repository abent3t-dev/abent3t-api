import { Controller, Get, Param, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
// TS1272: tipos en firmas decoradas van con `import type` (isolatedModules
// + emitDecoratorMetadata).
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { hasAnyRole } from '../common/utils/roles.util';
import { MaximoContractQueryDto } from './dto/maximo-contract-query.dto';
import { MaximoPoQueryDto } from './dto/maximo-po-query.dto';
import { MaximoRecordsService } from './maximo-records.service';

// Roles de compras (§Roles y Permisos de CLAUDE_COMPRAS.md)
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];
const APPROVERS = [
  'aprobador_nivel_1',
  'aprobador_nivel_2',
  'aprobador_nivel_3',
  'director_general',
];
// Lectores de datos Maximo; super_admin bypassa RolesGuard.
const MAXIMO_VIEWERS = [...PURCHASE_TEAM, ...APPROVERS, 'executive'];
// El `raw` del detalle solo viaja a los admins de compras.
const PURCHASE_ADMINS = ['super_admin', 'lider_procura'];

/**
 * Fase INT-5 — Lectura de dominio sobre el staging de Maximo (GET only).
 * El disparo manual y el status del sync viven en los endpoints de Int-3
 * y NO se re-exponen aquí.
 */
@Controller('maximo')
export class MaximoRecordsController {
  constructor(private readonly service: MaximoRecordsService) {}

  @Roles(...MAXIMO_VIEWERS)
  @Get('summary')
  getSummary() {
    return this.service.getSummary();
  }

  @Roles(...MAXIMO_VIEWERS)
  @Get('purchase-orders')
  listPurchaseOrders(@Query() query: MaximoPoQueryDto) {
    return this.service.listPurchaseOrders(query);
  }

  @Roles(...MAXIMO_VIEWERS)
  @Get('purchase-orders/:ponum')
  getPurchaseOrder(
    @Param('ponum') ponum: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.getPurchaseOrder(
      ponum,
      hasAnyRole(user, ...PURCHASE_ADMINS),
    );
  }

  @Roles(...MAXIMO_VIEWERS)
  @Get('contracts')
  listContracts(@Query() query: MaximoContractQueryDto) {
    return this.service.listContracts(query);
  }

  @Roles(...MAXIMO_VIEWERS)
  @Get('contracts/:key')
  getContract(@Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.service.getContract(key, hasAnyRole(user, ...PURCHASE_ADMINS));
  }
}
