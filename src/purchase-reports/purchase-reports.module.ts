import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ExpeditingModule } from '../expediting/expediting.module';
import { PurchaseCommitteesModule } from '../purchase-committees/purchase-committees.module';
import { PurchaseReportsController } from './purchase-reports.controller';
import { PurchaseReportsService } from './purchase-reports.service';

/**
 * Fase Reportes — agregación de solo lectura. Importa los módulos cuyos
 * services exponen las fórmulas existentes (regla 3: una sola definición
 * por métrica); Prisma es @Global.
 */
@Module({
  imports: [ApprovalsModule, ExpeditingModule, PurchaseCommitteesModule],
  controllers: [PurchaseReportsController],
  providers: [PurchaseReportsService],
})
export class PurchaseReportsModule {}
