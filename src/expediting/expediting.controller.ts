import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ExpeditingService } from './expediting.service';
import { ExpeditingQueryDto } from './dto/expediting-query.dto';
import {
  FollowUpDto,
  ReceiptDto,
  RescheduleDto,
} from './dto/expediting-actions.dto';

// Roles de compras (§Roles y Permisos)
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];

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
  @Get('stats')
  getStats() {
    return this.service.getStats();
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
