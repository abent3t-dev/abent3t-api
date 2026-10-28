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
  FpaAssignSignerDto,
  FpaConsolidatedQueryDto,
  FpaCreateAreaDto,
  FpaDirectoryQueryDto,
  FpaVersionQueryDto,
} from './dto/fpa-query.dto';
import {
  FpaApproveParamsDto,
  FpaCreateVersionDto,
  FpaReopenVersionDto,
  FpaUpdateVersionDto,
  FpaVersionCommentDto,
  FpaVersionParamsDto,
} from './dto/fpa-version.dto';
import { FPA_ADMIN, FPA_EDITORS, FPA_ROLES, FPA_SEE_ALL } from './fpa-roles';
import { FpaService } from './fpa.service';
import { FpaVersionsService } from './fpa-versions.service';

/**
 * FP&A (A3, lunes 26-oct). Todos los handlers llevan @Roles, también los
 * GET: el módulo no es "ver todos" como Compras. El alcance por área (qué
 * presupuestos ve y edita cada quien) lo valida el service con
 * fpa_assignments. Contrato: abent3t-next/src/types/fpa.ts.
 */
@Controller('fpa')
export class FpaController {
  constructor(
    private readonly service: FpaService,
    private readonly versionsService: FpaVersionsService,
  ) {}

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
    return this.service.directory(query.search, query.rol);
  }

  // Firmantes generales (B2): planeación (visto bueno de parámetros y paso de
  // planeación) y CFO (paso final)

  @Roles(...FPA_ADMIN)
  @Get('firmantes')
  signers(@CurrentUser() user: AuthUser) {
    return this.service.listSigners(user);
  }

  @Roles(...FPA_ADMIN)
  @Post('firmantes')
  assignSigner(@Body() dto: FpaAssignSignerDto, @CurrentUser() user: AuthUser) {
    return this.service.assignSigner(user, dto);
  }

  // Versiones y sus parámetros (B2): las ve quien ve todo (planeación y CFO);
  // las cambia planeación

  @Roles(...FPA_SEE_ALL)
  @Get('versiones/:id')
  version(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.detail(user, id);
  }

  @Roles(...FPA_ADMIN)
  @Post('versiones')
  createVersion(
    @Body() dto: FpaCreateVersionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.create(user, dto);
  }

  /** Nombre y notas (no son parámetros). */
  @Roles(...FPA_ADMIN)
  @Put('versiones/:id')
  updateVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FpaUpdateVersionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.update(user, id, dto);
  }

  @Roles(...FPA_ADMIN)
  @Put('versiones/:id/parametros')
  setParams(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FpaVersionParamsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.setParams(user, id, dto);
  }

  @Roles(...FPA_ADMIN)
  @Post('versiones/:id/visto-bueno')
  @HttpCode(200)
  approveParams(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FpaApproveParamsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.approve(user, id, dto);
  }

  @Roles(...FPA_ADMIN)
  @Post('versiones/:id/abrir')
  @HttpCode(200)
  openVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.open(user, id);
  }

  @Roles(...FPA_ADMIN)
  @Post('versiones/:id/regresar')
  @HttpCode(200)
  giveBackVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FpaVersionCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.giveBack(user, id, dto.comment ?? null);
  }

  @Roles(...FPA_ADMIN)
  @Post('versiones/:id/cerrar')
  @HttpCode(200)
  closeVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FpaVersionCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.close(user, id, dto.comment ?? null);
  }

  @Roles(...FPA_ADMIN)
  @Post('versiones/:id/reabrir')
  @HttpCode(200)
  reopenVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FpaReopenVersionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.versionsService.reopen(user, id, dto.comment);
  }
}
