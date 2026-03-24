import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { Public } from '../common/decorators/public.decorator';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Public()
  @Get('summary')
  getSummary(@Query('year') year?: string) {
    return this.dashboardService.getSummary();
  }

  @Public()
  @Get('by-department')
  getByDepartment() {
    return this.dashboardService.getByDepartment();
  }

  @Public()
  @Get('by-institution')
  getByInstitution() {
    return this.dashboardService.getByInstitution();
  }

  @Public()
  @Get('completion-time')
  getCompletionTime() {
    return this.dashboardService.getCompletionTime();
  }
}
