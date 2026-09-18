import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
// TS1272: tipos en firmas decoradas van con `import type` (isolatedModules
// + emitDecoratorMetadata).
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { hasAnyRole } from '../common/utils/roles.util';
import { SapDocQueryDto } from './dto/sap-doc-query.dto';
import { SapRecordsService } from './sap-records.service';

// Roles de compras (§Roles y Permisos de CLAUDE_COMPRAS.md)
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];
const APPROVERS = [
  'aprobador_nivel_1',
  'aprobador_nivel_2',
  'aprobador_nivel_3',
  'director_general',
];
// Lectores de datos SAP; super_admin bypassa RolesGuard.
const SAP_VIEWERS = [...PURCHASE_TEAM, ...APPROVERS, 'executive'];
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

  @Roles(...SAP_VIEWERS)
  @Get('summary')
  getSummary() {
    return this.service.getSummary();
  }

  @Roles(...SAP_VIEWERS)
  @Get('purchase-orders')
  listPurchaseOrders(@Query() query: SapDocQueryDto) {
    return this.service.listPurchaseOrders(query);
  }

  @Roles(...SAP_VIEWERS)
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

  @Roles(...SAP_VIEWERS)
  @Get('purchase-requests')
  listPurchaseRequests(@Query() query: SapDocQueryDto) {
    return this.service.listPurchaseRequests(query);
  }

  @Roles(...SAP_VIEWERS)
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
