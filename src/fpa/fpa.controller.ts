import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthUser,
} from '../common/decorators/current-user.decorator';
import { sendExcel } from '../common/utils/excel-export.util';
import { FpaCalcInputDto, FpaLineInputDto } from './dto/fpa-line.dto';
import {
  FpaAssignDto,
  FpaConsolidatedQueryDto,
  FpaCreateAreaDto,
  FpaDirectoryQueryDto,
  FpaVersionQueryDto,
} from './dto/fpa-query.dto';
import { FPA_ADMIN, FPA_EDITORS, FPA_ROLES } from './fpa-roles';
import { FpaService } from './fpa.service';

/**
 * FP&A (A3, lunes 26-oct). Todos los handlers llevan @Roles, también los
 * GET: el módulo no es "ver todos" como Compras. El alcance por área (qué
 * presupuestos ve y edita cada quien) lo valida el service con
 * fpa_assignments. Contrato: abent3t-next/src/types/fpa.ts.
 */
@Controller('fpa')
export class FpaController {
  constructor(private readonly service: FpaService) {}

  @Roles(...FPA_ROLES)
  @Get('contexto')
  context(@CurrentUser() user: AuthUser) {
    return this.service.context(user);
  }

  @Roles(...FPA_ROLES)
  @Get('versiones')
  versions(@CurrentUser() user: AuthUser) {
    return this.service.listVersions(user);
  }

  @Roles(...FPA_ROLES)
  @Get('catalogo')
  catalog() {
    return this.service.catalog();
  }

  @Roles(...FPA_ROLES)
  @Get('presupuestos')
  budgets(@Query() query: FpaVersionQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.listBudgets(user, query.version_id);
  }

  @Roles(...FPA_ROLES)
  @Get('presupuestos/:id')
  budget(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.getBudget(user, id);
  }

  @Roles(...FPA_EDITORS)
  @Post('presupuestos/:id/lineas')
  createLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FpaLineInputDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.createLine(user, id, dto);
  }

  @Roles(...FPA_EDITORS)
  @Put('lineas/:id')
  updateLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FpaLineInputDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.updateLine(user, id, dto);
  }

  /**
   * Vista previa del cálculo de una línea, sin guardar (B1). Es de quien
   * captura: el CFO no abre el formulario (y ningún POST es suyo). El modal
   * la pide al dejar de teclear; detrás de Nginx todos comparten la IP del
   * límite global (100 por minuto por ruta), así que esta ruta barata lleva
   * uno más alto.
   */
  @Roles(...FPA_EDITORS)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post('calcular')
  @HttpCode(200)
  calculate(@Body() dto: FpaCalcInputDto, @CurrentUser() user: AuthUser) {
    return this.service.calculate(user, dto);
  }

  @Roles(...FPA_EDITORS)
  @Post('lineas/:id/baja')
  deactivateLine(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.deactivateLine(user, id);
  }

  @Roles(...FPA_ROLES)
  @Get('consolidado')
  consolidated(
    @Query() query: FpaConsolidatedQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.consolidated(user, query.version_id, query.agrupar);
  }

  @Roles(...FPA_ROLES)
  @Get('consolidado/export')
  async consolidatedExport(
    @Query() query: FpaConsolidatedQueryDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.service.consolidatedExcel(
      user,
      query.version_id,
      query.agrupar,
    );
    sendExcel(res, buffer, filename);
  }

  // Áreas y responsables: planeación (y super_admin)

  @Roles(...FPA_ADMIN)
  @Get('areas')
  areas() {
    return this.service.listAreas();
  }

  @Roles(...FPA_ADMIN)
  @Post('areas')
  createArea(@Body() dto: FpaCreateAreaDto, @CurrentUser() user: AuthUser) {
    return this.service.createArea(user, dto.name);
  }

  @Roles(...FPA_ADMIN)
  @Post('responsables')
  assign(@Body() dto: FpaAssignDto, @CurrentUser() user: AuthUser) {
    return this.service.assign(user, dto);
  }

  @Roles(...FPA_ADMIN)
  @Get('usuarios/directorio')
  directory(@Query() query: FpaDirectoryQueryDto) {
    return this.service.directory(query.search);
  }
}
