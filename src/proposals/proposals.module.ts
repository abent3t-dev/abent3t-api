import { Module } from '@nestjs/common';
import { ProposalsController } from './proposals.controller';
import { ProposalsService } from './proposals.service';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [EnrollmentsModule, AuditModule],
  controllers: [ProposalsController],
  providers: [ProposalsService],
  exports: [ProposalsService],
})
export class ProposalsModule {}
