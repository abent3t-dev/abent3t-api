import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Roles('admin_rh', 'director', 'jefe_area', 'executive')
  @Get('summary')
  getSummary(@Query('year') year?: string) {
    return this.dashboardService.getSummary();
  }

  @Roles('admin_rh', 'director', 'jefe_area', 'executive')
  @Get('by-department')
  getByDepartment() {
    return this.dashboardService.getByDepartment();
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
