import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  buildExcel,
  excelFilename,
  sendExcel,
  NO_DISPONIBLE,
} from '../common/utils/excel-export.util';
import type { ExcelColumn } from '../common/utils/excel-export.util';
import type {
  MaximoContractView,
  MaximoPurchaseOrderView,
} from './maximo-records.types';
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

/** Columnas del export = pestaña "Ordenes Maximo" (B1). AB_* no expuestos → "No disponible". */
const PO_COLUMNS: ExcelColumn<MaximoPurchaseOrderView>[] = [
  { header: 'PONUM', value: (r) => r.ponum, width: 14 },
  { header: 'Descripción', value: (r) => r.description, width: 44 },
  { header: 'Estatus', value: (r) => r.status, width: 10 },
  { header: 'Proveedor', value: (r) => r.vendor_name, width: 36 },
  { header: 'ID proveedor', value: (r) => r.vendor_id, width: 14 },
  { header: 'Monto', value: (r) => r.total_cost, kind: 'money', width: 16 },
  { header: 'Moneda', value: (r) => r.currency, width: 10 },
  { header: 'Departamento', value: (r) => r.department, width: 18 },
  {
    header: 'Clasificación',
    value: (r) => r.ab_clasfpo ?? NO_DISPONIBLE,
    width: 14,
  },
  {
    header: 'Tipo compra',
    value: (r) => r.ab_tipocomp ?? NO_DISPONIBLE,
    width: 14,
  },
  { header: 'Ahorro', value: (r) => r.ab_ahorro ?? NO_DISPONIBLE, width: 14 },
  { header: 'Solicitado por', value: (r) => r.requested_by, width: 18 },
  {
    header: 'F. Espera aprobación',
    value: (r) => r.waiting_approval_at,
    kind: 'date',
    width: 18,
  },
  {
    header: 'F. Aprobación',
    value: (r) => r.approved_at,
    kind: 'date',
    width: 14,
  },
  { header: 'Aprobó', value: (r) => r.approved_by, width: 14 },
  {
    header: 'F. Orden',
    value: (r) => r.created_at_source,
    kind: 'date',
    width: 14,
  },
  { header: 'Revisión', value: (r) => r.revisionnum, kind: 'int', width: 10 },
  { header: 'Sitio', value: (r) => r.siteid, width: 10 },
];

const CONTRACT_COLUMNS: ExcelColumn<MaximoContractView>[] = [
  { header: 'PRNUM', value: (r) => r.prnum, width: 14 },
  {
    header: 'Contrato',
    value: (r) => (r.has_contract ? r.contractnum : 'Sin contrato'),
    width: 14,
  },
  { header: 'Estatus', value: (r) => r.status, width: 10 },
  { header: 'Proveedor', value: (r) => r.vendor_name, width: 36 },
  {
    header: 'Valor contrato',
    value: (r) => r.contract_value,
    kind: 'money',
    width: 16,
  },
  { header: 'MAXVOL', value: (r) => r.maxvol ?? NO_DISPONIBLE, width: 14 },
  { header: 'Moneda', value: (r) => r.currency, width: 10 },
  {
    header: 'Inicio vigencia',
    value: (r) => r.start_date,
    kind: 'date',
    width: 14,
  },
  { header: 'Fin vigencia', value: (r) => r.end_date, kind: 'date', width: 14 },
  { header: 'Departamento', value: (r) => r.department, width: 18 },
  { header: 'Solicitado por', value: (r) => r.requested_by, width: 18 },
  {
    header: 'F. Solicitud',
    value: (r) => r.created_at_source,
    kind: 'date',
    width: 14,
  },
  {
    header: 'F. Aprobación',
    value: (r) => r.approved_at,
    kind: 'date',
    width: 14,
  },
  { header: 'Aprobó', value: (r) => r.approved_by, width: 14 },
  { header: 'Revisión', value: (r) => r.revisionnum, kind: 'int', width: 10 },
];

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

  // Export Excel (B1), ruta literal antes de ':ponum'. Nunca incluye raw.
  @Get('purchase-orders/export')
  async exportPurchaseOrders(
    @Query() query: MaximoPoQueryDto,
    @Res() res: Response,
  ) {
    const { rows, truncated } =
      await this.service.listPurchaseOrdersForExport(query);
    const buffer = await buildExcel('Ordenes Maximo', PO_COLUMNS, rows, {
      truncated,
    });
    sendExcel(res, buffer, excelFilename('ordenes_maximo'));
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

  // Export Excel (B1), ruta literal antes de ':key'.
  @Get('contracts/export')
  async exportContracts(
    @Query() query: MaximoContractQueryDto,
    @Res() res: Response,
  ) {
    const { rows, truncated } =
      await this.service.listContractsForExport(query);
    const buffer = await buildExcel(
      'Contratos Maximo',
      CONTRACT_COLUMNS,
      rows,
      { truncated },
    );
    sendExcel(res, buffer, excelFilename('contratos_maximo'));
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('contracts/:key')
  getContract(@Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.service.getContract(key, hasAnyRole(user, ...PURCHASE_ADMINS));
  }
}
