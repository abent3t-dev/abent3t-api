import {
  Controller,
  Get,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  /**
   * Reporte por persona
   */
  @Roles('admin_rh', 'executive')
  @Get('by-person')
  getByPerson(
    @Query('department_id') departmentId?: string,
    @Query('period_id') periodId?: string,
  ) {
    return this.service.getByPerson({
      department_id: departmentId,
      period_id: periodId,
    });
  }

  /**
   * Reporte por departamento
   */
  @Roles('admin_rh', 'executive')
  @Get('by-department')
  getByDepartment(@Query('period_id') periodId?: string) {
    return this.service.getByDepartment({ period_id: periodId });
  }

  /**
   * Reporte por institución
   */
  @Roles('admin_rh', 'executive')
  @Get('by-institution')
  getByInstitution() {
    return this.service.getByInstitution({});
  }

  /**
   * Reporte comparativo por período
   */
  @Roles('admin_rh', 'executive')
  @Get('by-period')
  getByPeriod() {
    return this.service.getByPeriod();
  }

  /**
   * Exportar reporte a CSV
   */
  @Roles('admin_rh', 'executive')
  @Get('export')
  async exportCSV(
    @Res() res: Response,
    @Query('type') type: 'person' | 'department' | 'institution' | 'period',
    @Query('department_id') departmentId?: string,
    @Query('period_id') periodId?: string,
  ) {
    const csv = await this.service.exportToCSV(type, {
      department_id: departmentId,
      period_id: periodId,
    });

    const filename = `reporte_${type}_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv); // BOM para Excel
  }
}
