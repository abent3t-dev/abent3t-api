import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { isAdmin, isManager, hasAnyRole } from '../common/utils/roles.util';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * Resuelve el departamento al que debe scopear la respuesta:
   *   - admin_rh / super_admin / executive → undefined (ven todo)
   *   - jefe_area / director → su propio department_id
   *
   * Si el usuario es manager pero no tiene department_id asignado, lanza 403
   * (no debería ser jefe sin departamento).
   */
  private resolveScope(user: AuthUser): string | undefined {
    if (isAdmin(user) || hasAnyRole(user, 'executive')) return undefined;
    if (isManager(user)) {
      if (!user.department_id) {
        throw new ForbiddenException(
          'Tu cuenta no tiene departamento asignado',
        );
      }
      return user.department_id;
    }
    return undefined;
  }

  @Roles('admin_rh', 'director', 'jefe_area', 'executive')
  @Get('summary')
  getSummary(@CurrentUser() user: AuthUser, @Query('year') _year?: string) {
    return this.dashboardService.getSummary(this.resolveScope(user));
  }

  @Roles('admin_rh', 'director', 'jefe_area', 'executive')
  @Get('by-department')
  getByDepartment(@CurrentUser() user: AuthUser) {
    return this.dashboardService.getByDepartment(this.resolveScope(user));
  }

  @Roles('admin_rh', 'director', 'jefe_area', 'executive')
  @Get('by-institution')
  getByInstitution() {
    return this.dashboardService.getByInstitution();
  }

  @Roles('admin_rh', 'director', 'jefe_area', 'executive')
  @Get('completion-time')
  getCompletionTime() {
    return this.dashboardService.getCompletionTime();
  }
}
