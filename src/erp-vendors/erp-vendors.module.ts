import { Global, Module } from '@nestjs/common';
import { MaximoVendorXrefService } from './maximo-vendor-xref.service';

/**
 * G1 (2026-09-28) — Proveedor efectivo de Maximo (cruce contra SAP).
 * @Global: lo usan Órdenes/Contratos de Maximo, Expeditación y Reportes;
 * Prisma es @Global.
 */
@Global()
@Module({
  providers: [MaximoVendorXrefService],
  exports: [MaximoVendorXrefService],
})
export class ErpVendorsModule {}
