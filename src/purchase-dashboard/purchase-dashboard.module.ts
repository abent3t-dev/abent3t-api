import { Module } from '@nestjs/common';
import { PurchaseDashboardController } from './purchase-dashboard.controller';
import { PurchaseDashboardService } from './purchase-dashboard.service';

/** Sprint 2026-09-22 (A1) — resumen del dashboard (solo lectura, Prisma @Global). */
@Module({
  controllers: [PurchaseDashboardController],
  providers: [PurchaseDashboardService],
})
export class PurchaseDashboardModule {}
