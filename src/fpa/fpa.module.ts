import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { FpaController } from './fpa.controller';
import { FpaService } from './fpa.service';
import { FpaVersionsService } from './fpa-versions.service';
import { FpaFlowService } from './fpa-flow.service';
import { FpaReminderScheduler } from './fpa-reminder.scheduler';

/**
 * FP&A (0021, A3): presupuesto por área, captura con el formato único y
 * consolidado. B2 (0022): versiones y sus parámetros con el visto bueno de
 * planeación. B3 (sin migración: las tablas son de 0021): flujo de aprobación,
 * bandeja de pendientes, avisos (correo y user:{id}) y recordatorio diario.
 * Diseño: documentation/FPA.md, secciones "Diseño" y "Bloque B". EmailModule,
 * SocketModule y PrismaModule (días hábiles) son globales.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [FpaController],
  providers: [
    FpaService,
    FpaVersionsService,
    FpaFlowService,
    FpaReminderScheduler,
  ],
})
export class FpaModule {}
