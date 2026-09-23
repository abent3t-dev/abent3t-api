import { Controller, Get, Query } from '@nestjs/common';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { PurchaseDashboardService } from './purchase-dashboard.service';

/**
 * Sprint 2026-09-22 (A1) — KPIs del dashboard de Compras agregando SAP +
 * Maximo + propias en un solo GET (evita que el front sume 5 llamadas).
 * Bloque 2026-09-23: filtro por año (D4) y KPIs de ahorro / CAPEX-OPEX de
 * Órdenes (D5).
 */
@Controller('compras/dashboard')
export class PurchaseDashboardController {
  constructor(private readonly service: PurchaseDashboardService) {}

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('summary')
  getSummary(@Query() query: DashboardQueryDto) {
    return this.service.getSummary(query.year ?? null);
  }

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  // D5: tarjetas "Ahorro acumulado" y "CAPEX / OPEX" de /compras/ordenes.
  @Get('ordenes-kpis')
  getOrdersKpis(@Query() query: DashboardQueryDto) {
    return this.service.getOrdersKpis(query.year ?? null);
  }
}
