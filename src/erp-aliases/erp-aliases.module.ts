import { Global, Module } from '@nestjs/common';
import { ErpAliasesController } from './erp-aliases.controller';
import { ErpAliasesService } from './erp-aliases.service';

/**
 * Bloque 2026-09-23 (D6) — Equivalencias de usuarios de SAP/Maximo.
 * @Global: la resolución de códigos → nombre la usan las lecturas de SAP,
 * Maximo, reportes y expeditación; Prisma es @Global.
 */
@Global()
@Module({
  controllers: [ErpAliasesController],
  providers: [ErpAliasesService],
  exports: [ErpAliasesService],
})
export class ErpAliasesModule {}
