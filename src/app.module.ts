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
import { RequestsModule } from './requests/requests.module';
import { ReportsModule } from './reports/reports.module';
import { AuditModule } from './audit/audit.module';
import { PersonnelModule } from './personnel/personnel.module';
import { ProposalsModule } from './proposals/proposals.module';
import { SocketModule } from './socket/socket.module';
// Modulos de Compras
import { SuppliersModule } from './suppliers/suppliers.module';
import { RequisitionsModule } from './requisitions/requisitions.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';
import { PurchaseTypesModule } from './purchase-types/purchase-types.module';
// Modulo de Plataformas (Crehana, etc.)
import { PlatformsModule } from './platforms/platforms.module';
// Modulos de Email y Recordatorios
import { EmailModule } from './email/email.module';
import { RemindersModule } from './reminders/reminders.module';
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
    RequestsModule,
    ReportsModule,
    AuditModule,
    PersonnelModule,
    ProposalsModule,
    SocketModule,
    // Modulos de Compras
    SuppliersModule,
    RequisitionsModule,
    ApprovalsModule,
    PurchaseOrdersModule,
    PurchaseTypesModule,
    // Modulo de Plataformas
    PlatformsModule,
    // Modulos de Email y Recordatorios
    EmailModule,
    RemindersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
