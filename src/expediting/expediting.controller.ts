import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  buildExcel,
  excelFilename,
  sendExcel,
} from '../common/utils/excel-export.util';
import type { ExcelColumn } from '../common/utils/excel-export.util';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ExpeditingService } from './expediting.service';
import { buyerLabel, expeditingDays } from './expediting.columns';
import { ExpeditingQueryDto } from './dto/expediting-query.dto';
import {
  FollowUpDto,
  ReceiptDto,
  RescheduleDto,
} from './dto/expediting-actions.dto';

// Roles de compras (§Roles y Permisos)
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];

type ExpeditingRow = Awaited<
  ReturnType<ExpeditingService['findAllForExport']>
>['rows'][number];

const SOURCE_LABEL: Record<string, string> = {
  abent: 'ABENT',
  sap: 'SAP',
  maximo: 'Maximo',
};
const STATUS_LABEL: Record<string, string> = {
  sin_fecha: 'Sin fecha',
  en_tiempo: 'En tiempo',
  en_riesgo: 'En riesgo',
  retrasada: 'Retrasada',
  parcial: 'Entrega parcial',
  entregada: 'Entregada',
};

/** D9: columnas del export = tabla de /compras/expeditacion (+ monto). */
const EXPEDITING_COLUMNS: ExcelColumn<ExpeditingRow>[] = [
  { header: 'PO', value: (r) => r.po_number, width: 14 },
  {
    header: 'Origen',
    value: (r) =>
      r.source === 'sap' && r.maximo_ponum
        ? `SAP (migrada de Maximo ${r.maximo_ponum})`
        : (SOURCE_LABEL[r.source] ?? r.source),
    width: 30,
  },
  { header: 'Proveedor', value: (r) => r.supplier?.legal_name, width: 40 },
  // E4: comprador (o "Capturó: …" en las OC de SAP, que no lo traen)
  { header: 'Comprador', value: buyerLabel, width: 30 },
  { header: 'Monto', value: (r) => r.amount, kind: 'money', width: 16 },
  { header: 'Moneda', value: (r) => r.currency, width: 10 },
  {
    header: 'Fecha vigente',
    value: (r) => r.effective_expected_date,
    kind: 'date',
    width: 14,
  },
  // E3: el número conserva el signo para poder sumar/filtrar en Excel
  {
    header: 'Días (negativo = retraso)',
    value: expeditingDays,
    kind: 'int',
    width: 14,
  },
  {
    header: 'Estatus',
    value: (r) => STATUS_LABEL[r.delivery_status] ?? r.delivery_status,
    width: 16,
  },
  {
    header: 'Alertas',
    value: (r) => (r.purchase_order_id ? (r.tracking?.alert_count ?? 0) : null),
    kind: 'int',
    width: 10,
  },
];

/**
 * Fase Expeditación — seguimiento de entregas de POs propias. Lectura para
 * viewers de compras; mutaciones solo PURCHASE_TEAM (el service es el único
 * escritor del tracking, regla 3).
 */
@Controller('compras/expeditacion')
export class ExpeditingController {
  constructor(private readonly service: ExpeditingService) {}

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get()
  findAll(@Query() query: ExpeditingQueryDto) {
    return this.service.findAll(query);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  // E1: las tarjetas reciben los mismos filtros que la lista.
  @Get('stats')
  getStats(@Query() query: ExpeditingQueryDto) {
    return this.service.getStats(query);
  }

  // E1: valores de una columna para el filtro "tipo Excel"; antes de ':poId'.
  @Get('facets')
  facets(@Query() query: ExpeditingQueryDto) {
    return this.service.facets(query);
  }

  // D9: export Excel con los mismos filtros; ruta literal ANTES de ':poId'.
  @Get('export')
  async exportExcel(@Query() query: ExpeditingQueryDto, @Res() res: Response) {
    const { rows, truncated } = await this.service.findAllForExport(query);
    const buffer = await buildExcel('Expeditacion', EXPEDITING_COLUMNS, rows, {
      truncated,
    });
    sendExcel(res, buffer, excelFilename('expeditacion'));
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get(':poId')
  findOne(@Param('poId', ParseUUIDPipe) poId: string) {
    return this.service.findOne(poId);
  }

  @Roles(...PURCHASE_TEAM)
  @Post(':poId/follow-up')
  followUp(
    @Param('poId', ParseUUIDPipe) poId: string,
    @Body() dto: FollowUpDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.registerFollowUp(poId, dto, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Post(':poId/reschedule')
  reschedule(
    @Param('poId', ParseUUIDPipe) poId: string,
    @Body() dto: RescheduleDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.reschedule(poId, dto, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Post(':poId/receipt')
  receipt(
    @Param('poId', ParseUUIDPipe) poId: string,
    @Body() dto: ReceiptDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.registerReceipt(poId, dto, user.id);
  }
}
