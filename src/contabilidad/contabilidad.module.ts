import { Module } from '@nestjs/common';
import { PerdidasFiscalesModule } from './perdidas-fiscales/perdidas-fiscales.module';
import { NoDeduciblesModule } from './no-deducibles/no-deducibles.module';
import { TenenciaModule } from './tenencia/tenencia.module';
import { OkrsModule } from './okrs/okrs.module';
// Futuros sub-módulos (cuando se completen integraciones SAP/SAT):
// import { EbitdaModule } from './ebitda/ebitda.module';
// import { UtilidadModule } from './utilidad/utilidad.module';
// import { CostosModule } from './costos/costos.module';
// import { FinanciamientoModule } from './financiamiento/financiamiento.module';
// import { ComplianceModule } from './compliance/compliance.module';
// import { ComplementosPagoModule } from './complementos-pago/complementos-pago.module';
// import { SapIntegrationModule } from './sap-integration/sap-integration.module';
// import { SatIntegrationModule } from './sat-integration/sat-integration.module';

/**
 * Módulo principal de Contabilidad y Compliance Fiscal
 *
 * Agrupa todos los sub-módulos del área de contabilidad:
 * - Fase 1: Módulos independientes (no requieren SAP/SAT)
 *   - Pérdidas Fiscales
 *   - No Deducibles
 *   - Tenencia Accionaria
 *   - OKRs del Área
 *
 * - Fase 2: Integración SAP B1 (pendiente)
 *   - EBITDA Dashboard
 *   - Costos de Ventas
 *   - Utilidad Financiera/Fiscal
 *   - Financiamiento e Intereses
 *
 * - Fase 3: Integración SAT (pendiente)
 *   - Compliance SAP-SAT
 *   - Complementos de Pago
 */
@Module({
  imports: [
    // Fase 1: Módulos independientes
    PerdidasFiscalesModule,
    NoDeduciblesModule,
    TenenciaModule,
    OkrsModule,
    // Los siguientes módulos se agregarán conforme se completen las integraciones
  ],
  exports: [
    PerdidasFiscalesModule,
    NoDeduciblesModule,
    TenenciaModule,
    OkrsModule,
  ],
})
export class ContabilidadModule {}
