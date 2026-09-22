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
  NO_DISPONIBLE,
} from '../common/utils/excel-export.util';
import type { ExcelColumn } from '../common/utils/excel-export.util';
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
import { SapRecordsService } from './sap-records.service';

// Roles de compras (§Roles y Permisos de CLAUDE_COMPRAS.md)
// Lectores de datos SAP; super_admin bypassa RolesGuard.
// El `raw` del detalle solo viaja a los admins de compras.
const PURCHASE_ADMINS = ['super_admin', 'lider_procura'];

const STATUS_LABEL: Record<string, string> = {
  open: 'Abierta',
  close: 'Cerrada',
  cancelled: 'Cancelada',
};
const statusLabel = (row: {
  status_key: string | null;
  document_status: string | null;
}) =>
  (row.status_key && STATUS_LABEL[row.status_key]) || row.document_status || '';
const clasif = (row: { lines_total: number; lines_classified: number }) =>
  row.lines_total === 0
    ? ''
    : row.lines_classified === 0
      ? 'Sin clasificar'
      : `${row.lines_classified}/${row.lines_total}`;

/** Columnas del export = columnas visibles de la pestaña "Ordenes SAP" (B1). */
const PO_COLUMNS: ExcelColumn<SapPurchaseOrderRow>[] = [
  { header: 'Número', value: (r) => r.doc_num, kind: 'int', width: 12 },
  { header: 'DocEntry', value: (r) => r.doc_entry, kind: 'int', width: 12 },
  { header: 'Proveedor', value: (r) => r.card_name, width: 40 },
  { header: 'Código proveedor', value: (r) => r.card_code, width: 16 },
  { header: 'Estatus', value: statusLabel, width: 12 },
  { header: 'Monto', value: (r) => r.doc_total, kind: 'money', width: 16 },
  { header: 'Moneda', value: (r) => r.currency, width: 10 },
  { header: 'F. Documento', value: (r) => r.doc_date, kind: 'date', width: 14 },
  {
    header: 'F. Entrega',
    value: (r) => r.doc_due_date,
    kind: 'date',
    width: 14,
  },
  {
    header: 'F. Cierre',
    value: (r) => r.closing_date,
    kind: 'date',
    width: 14,
  },
  { header: 'Autorización', value: (r) => r.authorization_status, width: 16 },
  { header: 'Líneas', value: (r) => r.lines_total, kind: 'int', width: 10 },
  { header: 'Clasif. líneas', value: clasif, width: 14 },
  {
    header: 'Ahorro',
    value: (r) => r.ahorro_total ?? NO_DISPONIBLE,
    width: 14,
  },
  { header: 'Comentarios', value: (r) => r.comments, width: 40 },
];

const PR_COLUMNS: ExcelColumn<SapPurchaseRequestRow>[] = [
  { header: 'Número', value: (r) => r.doc_num, kind: 'int', width: 12 },
  { header: 'DocEntry', value: (r) => r.doc_entry, kind: 'int', width: 12 },
  { header: 'Solicitante', value: (r) => r.requester_name, width: 32 },
  { header: 'Usuario', value: (r) => r.requester, width: 14 },
  { header: 'Estatus', value: statusLabel, width: 12 },
  {
    header: 'Monto (líneas)',
    value: (r) => r.doc_total,
    kind: 'money',
    width: 16,
  },
  { header: 'Moneda', value: (r) => r.currency, width: 10 },
  { header: 'F. Documento', value: (r) => r.doc_date, kind: 'date', width: 14 },
  {
    header: 'F. Requerida',
    value: (r) => r.required_date,
    kind: 'date',
    width: 14,
  },
  {
    header: 'F. Cierre',
    value: (r) => r.closing_date,
    kind: 'date',
    width: 14,
  },
  { header: 'Autorización', value: (r) => r.authorization_status, width: 16 },
  { header: 'Líneas', value: (r) => r.lines_total, kind: 'int', width: 10 },
  { header: 'Clasif. líneas', value: clasif, width: 14 },
  {
    header: 'Ahorro',
    value: (r) => r.ahorro_total ?? NO_DISPONIBLE,
    width: 14,
  },
  { header: 'Comentarios', value: (r) => r.comments, width: 40 },
];

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
      PO_COLUMNS,
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
      PR_COLUMNS,
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
