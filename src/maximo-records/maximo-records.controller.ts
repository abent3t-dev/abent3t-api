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
import { MaximoSummaryQueryDto } from './dto/maximo-summary-query.dto';
import { MaximoRecordsService } from './maximo-records.service';
import type { MaximoContractGroupView } from './maximo-contract-groups';
import { buyerLabel } from '../common/utils/buyer.util';
import { MaximoVendorXrefService } from '../erp-vendors/maximo-vendor-xref.service';
import type { VendorMismatchExportRow } from '../erp-vendors/maximo-vendor-xref.service';
import {
  MISMATCH_LABELS,
  VENDOR_SOURCE_LABELS,
} from '../erp-vendors/maximo-vendor-xref';
import type { SupplierFields } from './maximo-records.types';

// Roles de compras (§Roles y Permisos de CLAUDE_COMPRAS.md)
// Lectores de datos Maximo; super_admin bypassa RolesGuard.
// El `raw` del detalle solo viaja a los admins de compras.
const PURCHASE_ADMINS = ['super_admin', 'lider_procura'];

/**
 * G1 (2026-09-28): columnas del proveedor efectivo (según SAP si la OC migró
 * o por cruce de código) + lo que dice el maestro de Maximo.
 */
function supplierColumns<
  T extends SupplierFields & {
    vendor_id: string | null;
    vendor_name: string | null;
  },
>(): ExcelColumn<T>[] {
  return [
    { header: 'Proveedor', value: (r) => r.supplier_name, width: 36 },
    { header: 'Código proveedor', value: (r) => r.supplier_code, width: 14 },
    {
      header: 'Origen del proveedor',
      value: (r) =>
        r.supplier_source ? VENDOR_SOURCE_LABELS[r.supplier_source] : null,
      width: 26,
    },
    { header: 'Proveedor en Maximo', value: (r) => r.vendor_name, width: 36 },
    { header: 'ID proveedor Maximo', value: (r) => r.vendor_id, width: 14 },
  ];
}

/** G1.3: lista para corregir el maestro de proveedores de Maximo. */
const VENDOR_MISMATCH_COLUMNS: ExcelColumn<VendorMismatchExportRow>[] = [
  { header: 'Código en Maximo', value: (r) => r.maximo_code, width: 14 },
  { header: 'Nombre en Maximo', value: (r) => r.maximo_name, width: 40 },
  { header: 'Código en SAP', value: (r) => r.sap_code, width: 14 },
  { header: 'Nombre en SAP', value: (r) => r.sap_name, width: 40 },
  { header: 'Caso', value: (r) => MISMATCH_LABELS[r.kind], width: 34 },
  {
    header: 'OC migradas (este par)',
    value: (r) => r.migrated,
    kind: 'int',
    width: 12,
  },
  {
    header: 'OC migradas del proveedor Maximo',
    value: (r) => r.migrated_total,
    kind: 'int',
    width: 14,
  },
  {
    header: '% de cobertura',
    value: (r) => r.coverage_pct,
    width: 12,
  },
  {
    header: 'OC vigentes en Maximo',
    value: (r) => r.maximo_orders,
    kind: 'int',
    width: 12,
  },
  {
    header: 'Monto en Maximo MXN',
    value: (r) =>
      r.maximo_amounts.find((a) => a.currency === 'MXN')?.total ?? null,
    kind: 'money',
    width: 18,
  },
  {
    header: 'Monto en Maximo USD',
    value: (r) =>
      r.maximo_amounts.find((a) => a.currency === 'USD')?.total ?? null,
    kind: 'money',
    width: 16,
  },
  {
    header: 'Otras monedas',
    value: (r) =>
      r.maximo_amounts
        .filter((a) => a.currency !== 'MXN' && a.currency !== 'USD')
        .map(
          (a) =>
            `${a.currency ?? 'sin moneda'} ${a.total.toLocaleString('es-MX')}`,
        )
        .join(' · ') || null,
    width: 22,
  },
];

/** Columnas del export = pestaña "Ordenes Maximo" (B1). AB_* no expuestos → "No disponible". */
const PO_COLUMNS: ExcelColumn<MaximoPurchaseOrderView>[] = [
  { header: 'PONUM', value: (r) => r.ponum, width: 14 },
  { header: 'Descripción', value: (r) => r.description, width: 44 },
  { header: 'Estatus', value: (r) => r.status, width: 10 },
  ...supplierColumns<MaximoPurchaseOrderView>(),
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
  {
    header: 'Solicitado por',
    value: (r) => r.requested_by_name ?? r.requested_by,
    width: 22,
  },
  { header: 'Usuario solicitante', value: (r) => r.requested_by, width: 16 },
  // E4: comprador de la OC (PURCHASEAGENT) con su nombre
  // F1: sin PURCHASEAGENT, "Capturó: …" = quién creó la OC en Maximo
  { header: 'Comprador', value: buyerLabel, width: 28 },
  { header: 'Usuario comprador', value: (r) => r.purchase_agent, width: 16 },
  { header: 'Creó la OC (usuario)', value: (r) => r.created_by, width: 16 },
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
  {
    header: 'Aprobó',
    value: (r) => r.approved_by_name ?? r.approved_by,
    width: 22,
  },
  { header: 'Usuario aprobador', value: (r) => r.approved_by, width: 16 },
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
  ...supplierColumns<MaximoContractView>(),
  {
    header: 'Valor contrato',
    value: (r) => r.contract_value,
    kind: 'money',
    width: 16,
  },
  {
    header: 'Consumido',
    value: (r) => r.consumed_value ?? NO_DISPONIBLE,
    width: 16,
  },
  {
    header: 'Saldo',
    value: (r) => r.balance_value ?? NO_DISPONIBLE,
    width: 16,
  },
  { header: 'Monto PR', value: (r) => r.pr_total ?? NO_DISPONIBLE, width: 16 },
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
  {
    header: 'Solicitado por',
    value: (r) => r.requested_by_name ?? r.requested_by,
    width: 22,
  },
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
  {
    header: 'Aprobó',
    value: (r) => r.approved_by_name ?? r.approved_by,
    width: 22,
  },
  { header: 'Revisión', value: (r) => r.revisionnum, kind: 'int', width: 10 },
];

/** E2: export de la vista agrupada por contrato (una fila por contrato). */
const CONTRACT_GROUP_COLUMNS: ExcelColumn<MaximoContractGroupView>[] = [
  { header: 'Contrato', value: (r) => r.contractnum, width: 14 },
  {
    header: 'Solicitudes (PR)',
    value: (r) => r.pr_count,
    kind: 'int',
    width: 14,
  },
  {
    header: 'PR ligadas',
    value: (r) => r.prs.map((p) => p.prnum).join(', '),
    width: 40,
  },
  { header: 'Estatus', value: (r) => r.status, width: 10 },
  ...supplierColumns<MaximoContractGroupView>(),
  {
    header: 'Valor contrato',
    value: (r) => r.contract_value,
    kind: 'money',
    width: 16,
  },
  {
    header: 'Consumido',
    value: (r) => r.consumed_value ?? NO_DISPONIBLE,
    width: 16,
  },
  {
    header: 'Saldo',
    value: (r) => r.balance_value ?? NO_DISPONIBLE,
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
  { header: 'Revisión', value: (r) => r.revisionnum, kind: 'int', width: 10 },
];

/**
 * Fase INT-5 — Lectura de dominio sobre el staging de Maximo (GET only).
 * El disparo manual y el status del sync viven en los endpoints de Int-3
 * y NO se re-exponen aquí.
 */
@Controller('maximo')
export class MaximoRecordsController {
  constructor(
    private readonly service: MaximoRecordsService,
    private readonly vendors: MaximoVendorXrefService,
  ) {}

  // G1: cuántos proveedores de Maximo tienen otro nombre en SAP (lectura abierta)
  @Get('vendor-xref')
  vendorXrefSummary() {
    return this.vendors.mismatchSummary();
  }

  // G1.3: "Proveedores con nombre distinto en Maximo y SAP" (para Alfredo)
  @Get('vendor-xref/export')
  async exportVendorXref(@Res() res: Response) {
    const rows = await this.vendors.mismatchRows();
    const buffer = await buildExcel(
      'Nombres distintos',
      VENDOR_MISMATCH_COLUMNS,
      rows,
      {
        note: 'Cruce por las OC de Maximo que migraron a SAP (NumAtCard = PONUM). Nombre distinto: el proveedor de SAP cubre al menos el 90% de sus OC migradas (mínimo 2). Ambiguo: sus OC cayeron en varios proveedores de SAP. Montos de Maximo por moneda (OC vigentes no canceladas).',
      },
    );
    sendExcel(res, buffer, excelFilename('proveedores_maximo_vs_sap'));
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('summary')
  getSummary(@Query() query: MaximoSummaryQueryDto) {
    return this.service.getSummary(query.year ?? null);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('purchase-orders')
  listPurchaseOrders(@Query() query: MaximoPoQueryDto) {
    return this.service.listPurchaseOrders(query);
  }

  // E1: valores de una columna para el filtro "tipo Excel"; antes de ':ponum'.
  @Get('purchase-orders/facets')
  purchaseOrderFacets(@Query() query: MaximoPoQueryDto) {
    return this.service.purchaseOrderFacets(query);
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
    // E2: `group=contract` → una fila por contrato con sus PR
    return query.group === 'contract'
      ? this.service.listContractGroups(query)
      : this.service.listContracts(query);
  }

  // E1: valores de una columna para el filtro "tipo Excel"; antes de ':key'.
  @Get('contracts/facets')
  contractFacets(@Query() query: MaximoContractQueryDto) {
    return query.group === 'contract'
      ? this.service.contractGroupFacets(query)
      : this.service.contractFacets(query);
  }

  // Export Excel (B1), ruta literal antes de ':key'.
  @Get('contracts/export')
  async exportContracts(
    @Query() query: MaximoContractQueryDto,
    @Res() res: Response,
  ) {
    if (query.group === 'contract') {
      const grouped = await this.service.listContractGroupsForExport(query);
      const buffer = await buildExcel(
        'Contratos Maximo',
        CONTRACT_GROUP_COLUMNS,
        grouped.rows,
        { truncated: grouped.truncated },
      );
      sendExcel(res, buffer, excelFilename('contratos_maximo'));
      return;
    }
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
