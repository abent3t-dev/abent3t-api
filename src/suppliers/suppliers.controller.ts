import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  buildExcel,
  excelFilename,
  sendExcel,
} from '../common/utils/excel-export.util';
import type { ExcelColumn } from '../common/utils/excel-export.util';
import { SuppliersService } from './suppliers.service';
import { SupplierSapMirrorService } from './supplier-sap-mirror.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// Roles de compras. Modelo de acceso (junta 2026-09-17): los GET de consulta
// van SIN @Roles = cualquier autenticado (precedente §15 Contratos); las
// mutaciones conservan roles estrictos.
const PURCHASE_ADMINS = ['super_admin', 'lider_procura'];

type SupplierExportRow = Awaited<
  ReturnType<SuppliersService['findAllForExport']>
>['rows'][number];

/** Columnas del export = tabla de /compras/proveedores (B1). */
const SUPPLIER_COLUMNS: ExcelColumn<SupplierExportRow>[] = [
  { header: 'Razón social', value: (r) => r.legal_name, width: 40 },
  { header: 'Nombre comercial', value: (r) => r.commercial_name, width: 30 },
  { header: 'RFC', value: (r) => r.tax_id, width: 18 },
  {
    header: 'Origen',
    value: (r) => (r.source === 'sap' ? 'SAP' : 'ABENT'),
    width: 10,
  },
  { header: 'Código SAP', value: (r) => r.external_id, width: 12 },
  { header: 'Contacto', value: (r) => r.contact_name, width: 24 },
  { header: 'Email', value: (r) => r.contact_email ?? r.email, width: 28 },
  { header: 'Teléfono', value: (r) => r.contact_phone ?? r.phone, width: 16 },
  {
    header: 'Moneda',
    value: (r) => (r.currency === '##' ? 'Multi' : r.currency),
    width: 10,
  },
  {
    header: 'Puntuación',
    value: (r) =>
      r.performance_score === null ? null : Number(r.performance_score),
    kind: 'int',
    width: 12,
  },
  {
    header: 'Estado ABENT',
    value: (r) => (r.is_blocked ? 'Bloqueado' : 'Activo'),
    width: 14,
  },
  {
    header: 'Inactivo en SAP',
    value: (r) =>
      r.sap_valid === false ? 'Sí' : r.sap_valid === null ? '' : 'No',
    width: 14,
  },
  { header: 'Motivo bloqueo', value: (r) => r.blocked_reason, width: 30 },
];

@Controller('suppliers')
export class SuppliersController {
  constructor(
    private readonly service: SuppliersService,
    private readonly sapMirror: SupplierSapMirrorService,
  ) {}

  /**
   * Espejo manual staging SAP → catálogo (además del cron horario). Ruta
   * literal declarada antes de las rutas con :id (convención del repo).
   */
  @Roles(...PURCHASE_ADMINS)
  @Post('sap-mirror')
  runSapMirror() {
    return this.sapMirror.runMirror();
  }

  // Export Excel (B1): mismos filtros que el listado; ruta literal antes de ':id'.
  @Get('export')
  async exportExcel(
    @Query() pagination: PaginationDto,
    @Res() res: Response,
    @Query('is_blocked') isBlocked?: string,
    @Query('min_score') minScore?: string,
  ) {
    const { rows, truncated } = await this.service.findAllForExport(
      pagination,
      {
        is_blocked: isBlocked !== undefined ? isBlocked === 'true' : undefined,
        min_score: minScore ? parseInt(minScore, 10) : undefined,
      },
    );
    const buffer = await buildExcel('Proveedores', SUPPLIER_COLUMNS, rows, {
      truncated,
    });
    sendExcel(res, buffer, excelFilename('proveedores'));
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get()
  findAll(
    @Query() pagination: PaginationDto,
    @Query('is_blocked') isBlocked?: string,
    @Query('min_score') minScore?: string,
  ) {
    const filters = {
      is_blocked: isBlocked !== undefined ? isBlocked === 'true' : undefined,
      min_score: minScore ? parseInt(minScore, 10) : undefined,
    };

    if (
      pagination.page ||
      pagination.limit ||
      pagination.search ||
      Object.values(filters).some((v) => v !== undefined)
    ) {
      return this.service.findAllFiltered(pagination, filters);
    }
    return this.service.findAll();
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get(':id/performance')
  getPerformance(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getPerformance(id);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get(':id/purchase-orders')
  getPurchaseOrders(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.service.getPurchaseOrders(id, pagination);
  }

  @Roles(...PURCHASE_ADMINS)
  @Post()
  create(@Body() dto: CreateSupplierDto) {
    return this.service.create(dto);
  }

  @Roles(...PURCHASE_ADMINS)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.service.update(id, dto);
  }

  @Roles(...PURCHASE_ADMINS)
  @Put(':id/evaluate')
  evaluate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('score') score: number,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.evaluate(id, score, user.id);
  }

  @Roles(...PURCHASE_ADMINS)
  @Put(':id/block')
  block(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('reason') reason: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.block(id, reason, user.id);
  }

  @Roles(...PURCHASE_ADMINS)
  @Put(':id/unblock')
  unblock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.unblock(id, user.id);
  }

  @Roles(...PURCHASE_ADMINS)
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
