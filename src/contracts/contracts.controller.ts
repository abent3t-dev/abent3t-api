import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  buildExcel,
  excelFilename,
  sendExcel,
  NO_DISPONIBLE,
} from '../common/utils/excel-export.util';
import type { ExcelColumn } from '../common/utils/excel-export.util';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ContractsService } from './contracts.service';
import { ContractQueryDto } from './dto/contract-query.dto';
import { CreateContractDto } from './dto/create-contract.dto';
import { UpdateContractDto } from './dto/update-contract.dto';

// Roles de compras
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];

type ContractExportRow = Awaited<
  ReturnType<ContractsService['findAllForExport']>
>['rows'][number];

const STATUS_LABEL: Record<string, string> = {
  vigente: 'Vigente',
  vencido: 'Vencido',
  renovado: 'Renovado',
  cancelado: 'Cancelado',
};

/** Columnas del export = tabla de /compras/contratos (B1 + B4). */
const CONTRACT_COLUMNS: ExcelColumn<ContractExportRow>[] = [
  { header: 'Número', value: (r) => r.contract_number, width: 16 },
  { header: 'Tomo', value: (r) => r.tomo, width: 10 },
  { header: 'Tipo', value: (r) => r.document_type, width: 14 },
  { header: 'Servicio', value: (r) => r.service_description, width: 44 },
  { header: 'Proveedor', value: (r) => r.supplier?.legal_name, width: 36 },
  {
    header: 'Inicio vigencia',
    value: (r) => r.start_date,
    kind: 'date',
    width: 14,
  },
  { header: 'Fin vigencia', value: (r) => r.end_date, kind: 'date', width: 14 },
  { header: 'Monto', value: (r) => r.total_amount ?? NO_DISPONIBLE, width: 16 },
  {
    header: 'Consumido',
    value: (r) => r.consumed_amount ?? NO_DISPONIBLE,
    width: 16,
  },
  {
    header: 'Saldo',
    value: (r) => r.balance_amount ?? NO_DISPONIBLE,
    width: 16,
  },
  { header: 'Moneda', value: (r) => r.currency, width: 10 },
  { header: 'Comprador', value: (r) => r.buyer?.full_name, width: 24 },
  { header: 'Responsable', value: (r) => r.responsible_user_name, width: 24 },
  {
    header: 'Estatus',
    value: (r) => STATUS_LABEL[r.status] ?? r.status,
    width: 12,
  },
  { header: 'Link', value: (r) => r.external_link, width: 40 },
  { header: 'Notas', value: (r) => r.notes, width: 40 },
];

/**
 * Fase §15 — Contratos (repositorio documental).
 *
 * CONVENCIÓN EXCEPCIONAL (documentada en §15/§17): los GET de este controller
 * NO declaran @Roles a propósito — es el primer apartado de Compras con
 * lectura para TODA la empresa; JwtAuthGuard sigue exigiendo sesión y
 * RolesGuard deja pasar a cualquier autenticado cuando no hay decorador.
 * Las mutaciones sí van con @Roles(...PURCHASE_TEAM).
 */
@Controller('compras/contratos')
export class ContractsController {
  constructor(private readonly service: ContractsService) {}

  // Lectura — cualquier usuario autenticado (sin @Roles, ver nota de clase)
  @Get()
  findAll(@Query() query: ContractQueryDto) {
    return this.service.findAll(query);
  }

  // E1: valores de una columna para el filtro "tipo Excel"; antes de ':id'.
  @Get('facets')
  facets(@Query() query: ContractQueryDto) {
    return this.service.facets(query);
  }

  // Export Excel (B1): mismos filtros que el listado; antes de ':id'.
  @Get('export')
  async exportExcel(@Query() query: ContractQueryDto, @Res() res: Response) {
    const { rows, truncated } = await this.service.findAllForExport(query);
    const buffer = await buildExcel('Contratos', CONTRACT_COLUMNS, rows, {
      truncated,
    });
    sendExcel(res, buffer, excelFilename('contratos'));
  }

  // Antes de ':id' para no colisionar con el ParseUUIDPipe
  @Roles(...PURCHASE_TEAM)
  @Get('alertas/vencimiento')
  findExpiring() {
    return this.service.findExpiring();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Get(':id/documents/:docId/download')
  download(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ) {
    return this.service.getDocumentDownloadUrl(id, docId);
  }

  // Mutaciones — solo equipo de procura
  @Roles(...PURCHASE_TEAM)
  @Post()
  create(@Body() dto: CreateContractDto, @CurrentUser() user: { id: string }) {
    return this.service.create(dto, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContractDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.update(id, dto, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.remove(id, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Post(':id/documents')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }),
  )
  uploadDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.uploadDocument(id, file, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Delete(':id/documents/:docId')
  removeDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.removeDocument(id, docId, user.id);
  }
}
