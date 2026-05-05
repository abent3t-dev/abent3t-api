import { Controller, Get, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  /**
   * Devuelve cuántos items "nuevos" hay por sección en el sidebar,
   * basado en el timestamp de última visita que envía el cliente.
   */
  @Get('sidebar-counts')
  getSidebarCounts(
    @CurrentUser() user: AuthUser,
    @Query('since_solicitudes') since_solicitudes?: string,
    @Query('since_propuestas') since_propuestas?: string,
    @Query('since_evidencias') since_evidencias?: string,
  ) {
    return this.service.getSidebarCounts(
      user.id,
      user.role,
      user.department_id || null,
      { since_solicitudes, since_propuestas, since_evidencias },
    );
  }
}
