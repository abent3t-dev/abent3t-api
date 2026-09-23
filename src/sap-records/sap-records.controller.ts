import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  buildExcel,
  excelFilename,
  sendExcel,
} from '../common/utils/excel-export.util';
import type {
  SapPurchaseOrderRow,
  SapPurchaseRequestRow,
} from './sap-records.types';
// TS1272: tipos en firmas decoradas van con `import type` (isolatedModules
// + emitDecoratorMetadata).
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { hasAnyRole } from '../common/utils/roles.util';
import { SapApprovalQueryDto } from './dto/sap-approval-query.dto';
import { SapDocQueryDto } from './dto/sap-doc-query.dto';
import { SapSummaryQueryDto } from './dto/sap-summary-query.dto';
import {
  SAP_PO_EXPORT_COLUMNS,
  SAP_PR_EXPORT_COLUMNS,
} from './sap-records.export';
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
  getSummary(@Query() query: SapSummaryQueryDto) {
    return this.service.getSummary(query.year ?? null);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  // Cola de autorización de SAP (B5): solo lectura, aprobar se hace en SAP.
  @Get('approval-requests')
  listApprovalRequests(@Query() query: SapApprovalQueryDto) {
    return this.service.listApprovalRequests(query);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('purchase-orders')
  listPurchaseOrders(@Query() query: SapDocQueryDto) {
    return this.service.listPurchaseOrders(query);
  }

  // Export Excel (B1): mismos filtros que el listado, sin paginar. Ruta
  // literal ANTES de ':docEntry'. Lectura abierta, nunca incluye raw.
  @Get('purchase-orders/export')
  async exportPurchaseOrders(
    @Query() query: SapDocQueryDto,
    @Res() res: Response,
  ) {
    const { rows, truncated } = await this.service.listAllForExport(
      'purchase_orders',
      query,
    );
    const buffer = await buildExcel(
      'Ordenes SAP',
      SAP_PO_EXPORT_COLUMNS,
      rows as SapPurchaseOrderRow[],
      { truncated },
    );
    sendExcel(res, buffer, excelFilename('ordenes_sap'));
  }

  @Get('purchase-requests/export')
  async exportPurchaseRequests(
    @Query() query: SapDocQueryDto,
    @Res() res: Response,
  ) {
    const { rows, truncated } = await this.service.listAllForExport(
      'purchase_requests',
      query,
    );
    const buffer = await buildExcel(
      'Solicitudes SAP',
      SAP_PR_EXPORT_COLUMNS,
      rows as SapPurchaseRequestRow[],
      { truncated },
    );
    sendExcel(res, buffer, excelFilename('solicitudes_sap'));
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
