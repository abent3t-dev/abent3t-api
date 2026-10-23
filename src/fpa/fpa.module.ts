import { Module } from '@nestjs/common';
import { FpaController } from './fpa.controller';
import { FpaService } from './fpa.service';

/**
 * FP&A (0021, A3): presupuesto por área, captura con el formato único y
 * consolidado. Diseño: documentation/FPA.md, sección "Diseño".
 */
@Module({
  controllers: [FpaController],
  providers: [FpaService],
})
export class FpaModule {}
