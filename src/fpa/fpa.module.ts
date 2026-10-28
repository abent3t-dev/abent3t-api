import { Module } from '@nestjs/common';
import { FpaController } from './fpa.controller';
import { FpaService } from './fpa.service';
import { FpaVersionsService } from './fpa-versions.service';

/**
 * FP&A (0021, A3): presupuesto por área, captura con el formato único y
 * consolidado. B2 (0022): versiones y sus parámetros con el visto bueno de
 * planeación. Diseño: documentation/FPA.md, secciones "Diseño" y "Bloque B".
 */
@Module({
  controllers: [FpaController],
  providers: [FpaService, FpaVersionsService],
})
export class FpaModule {}
