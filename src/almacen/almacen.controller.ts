import { Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { sendExcel } from '../common/utils/excel-export.util';
import { ALMACEN_ROLES } from './almacen-roles';
import { AlmacenService } from './almacen.service';

/**
 * Almacén (0026): el reporte de inventario al corte. Todos los handlers llevan
 * @Roles, también los GET (como FP&A): lo pinza almacen-access-model.spec.ts.
 * Solo lectura; los cortes se cargan con `npm run almacen:cargar`.
 */
@Controller('almacen')
export class AlmacenController {
  constructor(private readonly service: AlmacenService) {}

  @Roles(...ALMACEN_ROLES)
  @Get('cortes')
  cortes() {
    return this.service.cortes();
  }

  @Roles(...ALMACEN_ROLES)
  @Get('cortes/:id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detalle(id);
  }

  @Roles(...ALMACEN_ROLES)
  @Get('cortes/:id/existencias')
  existencias(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.existencias(id);
  }

  @Roles(...ALMACEN_ROLES)
  @Get('cortes/:id/excel')
  async excel(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { nombre, archivo } = await this.service.excel(id);
    sendExcel(res, archivo, nombre);
  }
}
