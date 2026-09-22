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

  // Sprint 2026-09-22 (B2): volumen y montos de SAP + Maximo por periodo.
  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('erp')
  getErp(@Query() query: ReportPeriodDto) {
    return this.service.getErp(query);
  }

  // Sprint 2026-09-22 (B3): tiempos de aprobación de SAP y Maximo.
  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('tiempos-aprobacion')
  getTiemposAprobacion() {
    return this.service.getTiemposAprobacion();
  }

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
