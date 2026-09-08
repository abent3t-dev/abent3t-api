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
const APPROVERS = [
  'aprobador_nivel_1',
  'aprobador_nivel_2',
  'aprobador_nivel_3',
  'director_general',
];
const EXPEDITING_VIEWERS = [...PURCHASE_TEAM, ...APPROVERS, 'executive'];

/**
 * Fase Expeditación — seguimiento de entregas de POs propias. Lectura para
 * viewers de compras; mutaciones solo PURCHASE_TEAM (el service es el único
 * escritor del tracking, regla 3).
 */
@Controller('compras/expeditacion')
export class ExpeditingController {
  constructor(private readonly service: ExpeditingService) {}

  @Roles(...EXPEDITING_VIEWERS)
  @Get()
  findAll(@Query() query: ExpeditingQueryDto) {
    return this.service.findAll(query);
  }

  @Roles(...EXPEDITING_VIEWERS)
  @Get('stats')
  getStats() {
    return this.service.getStats();
  }

  @Roles(...EXPEDITING_VIEWERS)
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
