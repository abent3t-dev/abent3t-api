import { Module } from '@nestjs/common';
import { AlmacenController } from './almacen.controller';
import { AlmacenService } from './almacen.service';

/**
 * Almacén (0026): el reporte de inventario al corte, de consulta
 * (documentation/ALMACEN.md). PrismaModule es global.
 */
@Module({
  controllers: [AlmacenController],
  providers: [AlmacenService],
})
export class AlmacenModule {}
