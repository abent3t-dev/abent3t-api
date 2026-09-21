import { Controller, Get, Param, Query } from '@nestjs/common';
// TS1272: tipos en firmas decoradas van con `import type` (isolatedModules
// + emitDecoratorMetadata).
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { hasAnyRole } from '../common/utils/roles.util';
import { MaximoContractQueryDto } from './dto/maximo-contract-query.dto';
import { MaximoPoQueryDto } from './dto/maximo-po-query.dto';
import { MaximoRecordsService } from './maximo-records.service';

// Roles de compras (§Roles y Permisos de CLAUDE_COMPRAS.md)
// Lectores de datos Maximo; super_admin bypassa RolesGuard.
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

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('summary')
  getSummary() {
    return this.service.getSummary();
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('purchase-orders')
  listPurchaseOrders(@Query() query: MaximoPoQueryDto) {
    return this.service.listPurchaseOrders(query);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
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

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('contracts')
  listContracts(@Query() query: MaximoContractQueryDto) {
    return this.service.listContracts(query);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('contracts/:key')
  getContract(@Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.service.getContract(key, hasAnyRole(user, ...PURCHASE_ADMINS));
  }
}
