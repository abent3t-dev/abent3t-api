import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthModule } from './auth/auth.module';
import { DepartmentsModule } from './departments/departments.module';
import { InstitutionsModule } from './institutions/institutions.module';
import { CourseTypesModule } from './course-types/course-types.module';
import { ModalitiesModule } from './modalities/modalities.module';
import { PeriodsModule } from './periods/periods.module';
import { CoursesModule } from './courses/courses.module';
import { BudgetsModule } from './budgets/budgets.module';
import { EnrollmentsModule } from './enrollments/enrollments.module';
import { EvidencesModule } from './evidences/evidences.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { SupabaseAuthGuard } from './common/guards/supabase-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    SupabaseModule,
    AuthModule,
    DepartmentsModule,
    InstitutionsModule,
    CourseTypesModule,
    ModalitiesModule,
    PeriodsModule,
    CoursesModule,
    BudgetsModule,
    EnrollmentsModule,
    EvidencesModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
