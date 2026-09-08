import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
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
import { NotificationsModule } from './notifications/notifications.module';
import { SocketModule } from './socket/socket.module';
// Modulos de Compras
import { SuppliersModule } from './suppliers/suppliers.module';
import { RequisitionsModule } from './requisitions/requisitions.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';
import { PurchaseTypesModule } from './purchase-types/purchase-types.module';
// Fase §15: repositorio documental de contratos (PDFs MinIO + alertas 30/7/0)
import { ContractsModule } from './contracts/contracts.module';
// Fase §16 (T7): directorio de usuarios de compras para selects
import { PurchaseUsersModule } from './purchase-users/purchase-users.module';
// Fase §16: Comité de Compras (workflow de aprobación data-driven)
import { PurchaseCommitteesModule } from './purchase-committees/purchase-committees.module';
// Fase Expeditación: seguimiento de entregas de POs propias + alertas
import { ExpeditingModule } from './expediting/expediting.module';
// Fase Reportes: agregación de solo lectura sobre compras + staging Maximo
import { PurchaseReportsModule } from './purchase-reports/purchase-reports.module';
// Modulo de Plataformas (Crehana, etc.)
import { PlatformsModule } from './platforms/platforms.module';
// Modulos de Email y Recordatorios
import { EmailModule } from './email/email.module';
import { RemindersModule } from './reminders/reminders.module';
// Modulo de Contabilidad y Compliance Fiscal
import { ContabilidadModule } from './contabilidad/contabilidad.module';
// Fase INT-1: infraestructura transversal de integraciones (GET-only)
import { IntegrationsModule } from './integrations/integrations.module';
// Fase INT-2: cliente Maximo (GET-only) + mapper; sin sync ni persistencia
import { MaximoModule } from './integrations/maximo/maximo.module';
// Fase INT-3: staging + sync engine + endpoints (gobernado por MAXIMO_SYNC_ENABLED)
import { MaximoSyncModule } from './integrations/maximo/sync/maximo-sync.module';
// Fase INT-5: lectura de dominio sobre el staging de Maximo (GET /maximo/*)
import { MaximoRecordsModule } from './maximo-records/maximo-records.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import {
  envValidationSchema,
  envValidationOptions,
} from './config/env.validation';

@Module({
  imports: [
    // Fase 0 (T1): validationSchema — si falta un secreto/conexión, la app
    // NO arranca y el error nombra la(s) variable(s). Ver DEPLOY_ENV_CHECKLIST.md.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: envValidationSchema,
      validationOptions: envValidationOptions,
    }),
    // Rate limiting global. Defaults razonables: 100 requests por IP por
    // minuto. Configurable vía THROTTLE_TTL_MS y THROTTLE_LIMIT.
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.THROTTLE_TTL_MS) || 60_000,
        limit: Number(process.env.THROTTLE_LIMIT) || 100,
      },
    ]),
    // PrismaModule y StorageModule son @Global() — exponen `PrismaService` y
    // `StorageService` a todos los módulos sin imports explícitos.
    PrismaModule,
    StorageModule,
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
    NotificationsModule,
    SocketModule,
    // Modulos de Compras
    SuppliersModule,
    RequisitionsModule,
    ApprovalsModule,
    PurchaseOrdersModule,
    PurchaseTypesModule,
    // §15: lectura abierta a cualquier autenticado; mutaciones PURCHASE_TEAM
    ContractsModule,
    // §16 (T7): GET /compras/usuarios para selects (PURCHASE_TEAM + APPROVERS)
    PurchaseUsersModule,
    // §16: Comité de Compras — aprobación secuencial leída de
    // committee_approval_levels (mapeo pendiente de confirmar con Ingrid)
    PurchaseCommitteesModule,
    // Expeditación: solo POs propias (el staging de Maximo no se expedita)
    ExpeditingModule,
    // Reportes de compras: consume fórmulas existentes, no crea variantes
    PurchaseReportsModule,
    // Modulo de Plataformas
    PlatformsModule,
    // Modulos de Email y Recordatorios
    EmailModule,
    RemindersModule,
    // Modulo de Contabilidad y Compliance Fiscal
    ContabilidadModule,
    // Integraciones externas (Maximo/SAP) — Fase INT-1: solo infraestructura.
    // Sin controllers, sin lectura de MAXIMO_*/SL_*, SOLO LECTURA (GET).
    IntegrationsModule,
    // Fase INT-2: MaximoClient + mapper. Arranca aunque MAXIMO_* estén vacías
    // (los métodos fallan tipado sin red). Sin cron ni staging (Int-3).
    MaximoModule,
    // Fase INT-3: staging + sync + endpoints /integrations/maximo. Con
    // MAXIMO_SYNC_ENABLED=false el cron no se registra y POST /sync → 503.
    MaximoSyncModule,
    // Fase INT-5: lectura de dominio del staging Maximo (GET /maximo/*),
    // sin dependencia de integrations/ y sin escrituras.
    MaximoRecordsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Orden de guards globales (se evalúan en el orden listado):
    // 1) Throttler primero para no gastar ciclos de auth en abuso de IP
    // 2) Autenticación
    // 3) Autorización por rol
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Fase 2: JwtAuthGuard reemplaza al viejo SupabaseAuthGuard. Valida el
    // JWT propio (cookie HttpOnly o Authorization header). El shape de
    // `request.user` no cambia — RolesGuard/DepartmentGuard siguen iguales.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
