import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { PurchaseReportsService } from './purchase-reports.service';
import { ReportPeriodDto } from './dto/report-period.dto';

// Roles de compras (§Roles y Permisos)
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];
const APPROVERS = [
  'aprobador_nivel_1',
  'aprobador_nivel_2',
  'aprobador_nivel_3',
  'director_general',
];
const REPORT_VIEWERS = [...PURCHASE_TEAM, ...APPROVERS, 'executive'];

/**
 * Fase Reportes — SOLO lectura/agregación sobre datos propios + staging
 * Maximo. Aprobaciones/entregas/comité consumen las fórmulas existentes
 * (acumuladas, sin from/to — regla 3).
 */
@Controller('compras/reportes')
export class PurchaseReportsController {
  constructor(private readonly service: PurchaseReportsService) {}

  @Roles(...REPORT_VIEWERS)
  @Get('resumen')
  getResumen(@Query() query: ReportPeriodDto) {
    return this.service.getResumen(query);
  }

  @Roles(...REPORT_VIEWERS)
  @Get('requisiciones')
  getRequisiciones(@Query() query: ReportPeriodDto) {
    return this.service.getRequisiciones(query);
  }

  @Roles(...REPORT_VIEWERS)
  @Get('ordenes')
  getOrdenes(@Query() query: ReportPeriodDto) {
    return this.service.getOrdenes(query);
  }

  @Roles(...REPORT_VIEWERS)
  @Get('aprobaciones')
  getAprobaciones() {
    return this.service.getAprobaciones();
  }

  @Roles(...REPORT_VIEWERS)
  @Get('entregas')
  getEntregas() {
    return this.service.getEntregas();
  }

  @Roles(...REPORT_VIEWERS)
  @Get('contratos')
  getContratos() {
    return this.service.getContratos();
  }

  @Roles(...REPORT_VIEWERS)
  @Get('comite')
  getComite() {
    return this.service.getComite();
  }

  @Roles(...REPORT_VIEWERS)
  @Get('maximo')
  getMaximo(@Query() query: ReportPeriodDto) {
    return this.service.getMaximo(query);
  }

  @Roles(...REPORT_VIEWERS)
  @Get('ahorro')
  getAhorro(@Query() query: ReportPeriodDto) {
    return this.service.getAhorro(query);
  }
}
