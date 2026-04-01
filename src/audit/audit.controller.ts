import {
  Controller,
  Get,
  Query,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AuditService } from './audit.service';
import type { AuditAction, AuditEntity } from './audit.service';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('audit')
export class AuditController {
  constructor(private readonly service: AuditService) {}

  /**
   * Listar logs de auditoría con filtros
   */
  @Roles('admin_rh')
  @Get()
  findAll(
    @Query('action') action?: AuditAction,
    @Query('entity_type') entityType?: AuditEntity,
    @Query('entity_id') entityId?: string,
    @Query('user_id') userId?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findAll(
      {
        action,
        entity_type: entityType,
        entity_id: entityId,
        user_id: userId,
        start_date: startDate,
        end_date: endDate,
      },
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 15,
    );
  }

  /**
   * Obtener logs de una entidad específica
   */
  @Roles('admin_rh')
  @Get('entity/:type/:id')
  findByEntity(
    @Param('type') entityType: AuditEntity,
    @Param('id', ParseUUIDPipe) entityId: string,
  ) {
    return this.service.findByEntity(entityType, entityId);
  }

  /**
   * Obtener logs de un usuario específico
   */
  @Roles('admin_rh')
  @Get('user/:id')
  findByUser(@Param('id', ParseUUIDPipe) userId: string) {
    return this.service.findByUser(userId);
  }

  /**
   * Obtener estadísticas de auditoría
   */
  @Roles('admin_rh')
  @Get('stats')
  getStats(
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ) {
    return this.service.getStats(startDate, endDate);
  }
}
