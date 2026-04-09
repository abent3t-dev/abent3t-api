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
import { RequisitionsService } from './requisitions.service';
import type { RequisitionStatus } from './requisitions.service';
import { CreateRequisitionDto } from './dto/create-requisition.dto';
import { UpdateRequisitionDto } from './dto/update-requisition.dto';
import { FilterRequisitionDto } from './dto/filter-requisition.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// Grupos de roles de compras
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];
const PURCHASE_VIEWERS = [
  ...PURCHASE_TEAM,
  'aprobador_nivel_1',
  'aprobador_nivel_2',
  'aprobador_nivel_3',
  'director_general',
  'solicitante',
];

@Controller('requisitions')
export class RequisitionsController {
  constructor(private readonly service: RequisitionsService) {}

  @Roles(...PURCHASE_VIEWERS)
  @Get()
  findAll(@Query() pagination: PaginationDto, @Query() filters: FilterRequisitionDto) {
    return this.service.findAll(pagination, filters);
  }

  @Roles(...PURCHASE_TEAM)
  @Get('stats')
  getStats(
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
  ) {
    return this.service.getStats({ date_from: dateFrom, date_to: dateTo });
  }

  @Roles(...PURCHASE_VIEWERS)
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Roles(...PURCHASE_VIEWERS)
  @Get(':id/history')
  getHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getHistory(id);
  }

  @Roles(...PURCHASE_TEAM, 'solicitante')
  @Post()
  create(
    @Body() dto: CreateRequisitionDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.create(dto, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Post('import')
  importFromExternal(
    @Body('requisitions') requisitions: CreateRequisitionDto[],
    @Body('source') source: 'maximo' | 'sap',
    @CurrentUser() user: { id: string },
  ) {
    return this.service.importFromExternal(requisitions, source, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRequisitionDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.update(id, dto, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Put(':id/status')
  changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('status') status: RequisitionStatus,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.changeStatus(id, status, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Put(':id/assign')
  assignBuyer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('buyer_id', ParseUUIDPipe) buyerId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.assignBuyer(id, buyerId, user.id);
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
