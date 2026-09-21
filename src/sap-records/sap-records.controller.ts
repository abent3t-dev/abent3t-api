import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
// TS1272: tipos en firmas decoradas van con `import type` (isolatedModules
// + emitDecoratorMetadata).
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { hasAnyRole } from '../common/utils/roles.util';
import { SapDocQueryDto } from './dto/sap-doc-query.dto';
import { SapRecordsService } from './sap-records.service';

// Roles de compras (§Roles y Permisos de CLAUDE_COMPRAS.md)
// Lectores de datos SAP; super_admin bypassa RolesGuard.
// El `raw` del detalle solo viaja a los admins de compras.
const PURCHASE_ADMINS = ['super_admin', 'lider_procura'];

/**
 * Fase INT-4 — Lectura de dominio sobre el staging de SAP (GET only).
 * El disparo manual y el status del sync viven en los endpoints de la capa
 * de sincronización y NO se re-exponen aquí. Mismo contrato que el módulo
 * de lectura del otro ERP (Int-5).
 */
@Controller('sap')
export class SapRecordsController {
  constructor(private readonly service: SapRecordsService) {}

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('summary')
  getSummary() {
    return this.service.getSummary();
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('purchase-orders')
  listPurchaseOrders(@Query() query: SapDocQueryDto) {
    return this.service.listPurchaseOrders(query);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('purchase-orders/:docEntry')
  getPurchaseOrder(
    @Param('docEntry', ParseIntPipe) docEntry: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.getPurchaseOrder(
      docEntry,
      hasAnyRole(user, ...PURCHASE_ADMINS),
    );
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('purchase-requests')
  listPurchaseRequests(@Query() query: SapDocQueryDto) {
    return this.service.listPurchaseRequests(query);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('purchase-requests/:docEntry')
  getPurchaseRequest(
    @Param('docEntry', ParseIntPipe) docEntry: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.getPurchaseRequest(
      docEntry,
      hasAnyRole(user, ...PURCHASE_ADMINS),
    );
  }
}
