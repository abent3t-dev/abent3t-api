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
} from '@nestjs/common';
import { PurchaseOrdersService } from './purchase-orders.service';
import type { POStatus } from './purchase-orders.service';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// Roles de compras
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];

@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly service: PurchaseOrdersService) {}

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get()
  findAll(
    @Query() pagination: PaginationDto,
    @Query('status') status?: string,
    @Query('supplier_id') supplierId?: string,
    @Query('purchase_type_id') purchaseTypeId?: string,
    @Query('expense_type') expenseType?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
  ) {
    return this.service.findAll(pagination, {
      // A5: uno o varios estatus separados por coma
      status: status
        ? (status
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean) as POStatus[])
        : undefined,
      supplier_id: supplierId,
      purchase_type_id: purchaseTypeId,
      expense_type: expenseType,
      date_from: dateFrom,
      date_to: dateTo,
    });
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('stats')
  getStats(
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    @Query('expense_type') expenseType?: string,
  ) {
    return this.service.getStats({
      date_from: dateFrom,
      date_to: dateTo,
      expense_type: expenseType,
    });
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('requisition/:rqId')
  findByRequisition(@Param('rqId', ParseUUIDPipe) rqId: string) {
    return this.service.findByRequisition(rqId);
  }

  @Roles(...PURCHASE_TEAM)
  @Post()
  create(
    @Body() dto: CreatePurchaseOrderDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.create(dto, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.update(id, dto, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Put(':id/status')
  changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('status') status: POStatus,
    @Body('actual_delivery_date') actualDeliveryDate: string | undefined,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.changeStatus(id, status, user.id, actualDeliveryDate);
  }

  @Roles(...PURCHASE_TEAM)
  @Delete(':id')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.cancel(id, user.id);
  }
}
