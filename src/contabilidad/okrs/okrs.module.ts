import { Module } from '@nestjs/common';
import { OkrsController } from './okrs.controller';
import { OkrsService } from './okrs.service';

@Module({
  controllers: [OkrsController],
  providers: [OkrsService],
  exports: [OkrsService],
})
export class OkrsModule {}
