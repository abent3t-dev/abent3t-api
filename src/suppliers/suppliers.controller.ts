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
import { SuppliersService } from './suppliers.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// Roles de compras
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];
const PURCHASE_ADMINS = ['super_admin', 'lider_procura'];

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly service: SuppliersService) {}

  @Roles(...PURCHASE_TEAM)
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

    if (pagination.page || pagination.limit || pagination.search || Object.values(filters).some(v => v !== undefined)) {
      return this.service.findAllFiltered(pagination, filters);
    }
    return this.service.findAll();
  }

  @Roles(...PURCHASE_TEAM)
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Roles(...PURCHASE_TEAM)
  @Get(':id/performance')
  getPerformance(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getPerformance(id);
  }

  @Roles(...PURCHASE_TEAM)
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
