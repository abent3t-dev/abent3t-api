import { Module } from '@nestjs/common';
import { NoDeduciblesController } from './no-deducibles.controller';
import { NoDeduciblesService } from './no-deducibles.service';

@Module({
  controllers: [NoDeduciblesController],
  providers: [NoDeduciblesService],
  exports: [NoDeduciblesService],
})
export class NoDeduciblesModule {}
