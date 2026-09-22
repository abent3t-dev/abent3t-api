import { Controller, Get } from '@nestjs/common';
import { PurchaseDashboardService } from './purchase-dashboard.service';

/**
 * Sprint 2026-09-22 (A1) — KPIs del dashboard de Compras agregando SAP +
 * Maximo + propias en un solo GET (evita que el front sume 5 llamadas).
 */
@Controller('compras/dashboard')
export class PurchaseDashboardController {
  constructor(private readonly service: PurchaseDashboardService) {}

  // Lectura abierta a cualquier autenticado ("ver todos, actuar por rol").
  @Get('summary')
  getSummary() {
    return this.service.getSummary();
  }
}
