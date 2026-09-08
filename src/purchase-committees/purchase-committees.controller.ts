import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PurchaseCommitteesService } from './purchase-committees.service';
import { CommitteeQueryDto } from './dto/committee-query.dto';
import { CommitteeVersionLinkDto } from './dto/committee-version-link.dto';
import { CreateCommitteeDto } from './dto/create-committee.dto';
import { RejectCommitteeDto } from './dto/reject-committee.dto';
import { UpdateApprovalLevelDto } from './dto/update-approval-level.dto';
import { UpdateCommitteeDto } from './dto/update-committee.dto';

// Roles de compras (§Roles y Permisos + §17)
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];
const APPROVERS = [
  'aprobador_nivel_1',
  'aprobador_nivel_2',
  'aprobador_nivel_3',
  'director_general',
];
// APPROVERS_COMITE (§17): lider_procura es el nivel 1 de la cadena
const APPROVERS_COMITE = ['lider_procura', ...APPROVERS];
const COMMITTEE_VIEWERS = [...PURCHASE_TEAM, ...APPROVERS, 'executive'];
const PURCHASE_ADMINS = ['super_admin', 'lider_procura'];

/**
 * Fase §16 — Comité de Compras. El turno de aprobación se valida en el
 * SERVICE contra committee_approval_levels (el guard de roles solo acota el
 * universo). Rutas literales antes de ':id' (ParseUUIDPipe).
 */
@Controller('compras/comite')
export class PurchaseCommitteesController {
  constructor(private readonly service: PurchaseCommitteesService) {}

  @Roles(...COMMITTEE_VIEWERS)
  @Get()
  findAll(@Query() query: CommitteeQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.findAll(query, user);
  }

  @Roles(...APPROVERS_COMITE)
  @Get('pendientes/me')
  pendingForMe(@CurrentUser() user: AuthUser) {
    return this.service.pendingForMe(user);
  }

  @Roles(...PURCHASE_TEAM, 'executive')
  @Get('dashboard/tiempos')
  dashboardTiempos() {
    return this.service.dashboardTiempos();
  }

  // Mapeo de la cadena (§20.A.5): lectura admins+executive, edición admins
  @Roles(...PURCHASE_ADMINS, 'executive')
  @Get('niveles')
  getLevels() {
    return this.service.getLevels();
  }

  @Roles(...PURCHASE_ADMINS)
  @Put('niveles/:id')
  updateLevel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateApprovalLevelDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.updateLevel(id, dto, user);
  }

  @Roles(...COMMITTEE_VIEWERS)
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.findOne(id, user);
  }

  @Roles(...COMMITTEE_VIEWERS)
  @Get(':id/versions/:versionId/download')
  download(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.service.getVersionDownload(id, versionId);
  }

  @Roles(...PURCHASE_TEAM)
  @Post()
  create(@Body() dto: CreateCommitteeDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Roles(...PURCHASE_TEAM)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCommitteeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, dto, user);
  }

  @Roles(...PURCHASE_TEAM)
  @Post(':id/versions')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 30 * 1024 * 1024 } }),
  )
  uploadVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CommitteeVersionLinkDto,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.uploadVersion(id, user, file, dto.external_link);
  }

  @Roles(...PURCHASE_TEAM)
  @Post(':id/submit')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.submit(id, user);
  }

  @Roles(...APPROVERS_COMITE)
  @Post(':id/approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.service.approve(id, user, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Roles(...APPROVERS_COMITE)
  @Post(':id/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectCommitteeDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.service.reject(id, dto, user, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}
