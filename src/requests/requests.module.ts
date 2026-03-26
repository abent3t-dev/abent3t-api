import { Module } from '@nestjs/common';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { EnrollmentsModule } from '../enrollments/enrollments.module';

@Module({
  imports: [SupabaseModule, EnrollmentsModule],
  controllers: [RequestsController],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
