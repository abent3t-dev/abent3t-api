import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ExpeditingModule } from '../expediting/expediting.module';
import { PurchaseCommitteesModule } from '../purchase-committees/purchase-committees.module';
import { SapRecordsModule } from '../sap-records/sap-records.module';
import { PurchaseReportsController } from './purchase-reports.controller';
import { PurchaseReportsService } from './purchase-reports.service';
import { WeeklyReportService } from './weekly-report.service';

/**
 * Fase Reportes — agregación de solo lectura. Importa los módulos cuyos
 * services exponen las fórmulas existentes (regla 3: una sola definición
 * por métrica); Prisma es @Global.
 */
@Module({
  imports: [
    ApprovalsModule,
    ExpeditingModule,
    PurchaseCommitteesModule,
    SapRecordsModule,
  ],
  controllers: [PurchaseReportsController],
  providers: [PurchaseReportsService, WeeklyReportService],
})
export class PurchaseReportsModule {}
