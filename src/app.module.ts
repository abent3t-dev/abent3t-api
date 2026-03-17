import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseModule } from './supabase/supabase.module';
import { DepartmentsModule } from './departments/departments.module';
import { InstitutionsModule } from './institutions/institutions.module';
import { CourseTypesModule } from './course-types/course-types.module';
import { ModalitiesModule } from './modalities/modalities.module';
import { PeriodsModule } from './periods/periods.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SupabaseModule,
    DepartmentsModule,
    InstitutionsModule,
    CourseTypesModule,
    ModalitiesModule,
    PeriodsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
