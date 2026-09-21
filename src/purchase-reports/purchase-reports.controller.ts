import { Controller, Get, Query } from '@nestjs/common';
import { PurchaseReportsService } from './purchase-reports.service';
import { ReportPeriodDto } from './dto/report-period.dto';

// Roles de compras (§Roles y Permisos)

/**
 * Fase Reportes — SOLO lectura/agregación sobre datos propios + staging
 * Maximo. Aprobaciones/entregas/comité consumen las fórmulas existentes
 * (acumuladas, sin from/to — regla 3).
 */
@Controller('compras/reportes')
export class PurchaseReportsController {
  constructor(private readonly service: PurchaseReportsService) {}

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('resumen')
  getResumen(@Query() query: ReportPeriodDto) {
    return this.service.getResumen(query);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('requisiciones')
  getRequisiciones(@Query() query: ReportPeriodDto) {
    return this.service.getRequisiciones(query);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('ordenes')
  getOrdenes(@Query() query: ReportPeriodDto) {
    return this.service.getOrdenes(query);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('aprobaciones')
  getAprobaciones() {
    return this.service.getAprobaciones();
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('entregas')
  getEntregas() {
    return this.service.getEntregas();
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('contratos')
  getContratos() {
    return this.service.getContratos();
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('comite')
  getComite() {
    return this.service.getComite();
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('maximo')
  getMaximo(@Query() query: ReportPeriodDto) {
    return this.service.getMaximo(query);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('ahorro')
  getAhorro(@Query() query: ReportPeriodDto) {
    return this.service.getAhorro(query);
  }
}
