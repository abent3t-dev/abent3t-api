import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ContractsService } from './contracts.service';
import { ContractQueryDto } from './dto/contract-query.dto';
import { CreateContractDto } from './dto/create-contract.dto';
import { UpdateContractDto } from './dto/update-contract.dto';

// Roles de compras
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];

/**
 * Fase §15 — Contratos (repositorio documental).
 *
 * CONVENCIÓN EXCEPCIONAL (documentada en §15/§17): los GET de este controller
 * NO declaran @Roles a propósito — es el primer apartado de Compras con
 * lectura para TODA la empresa; JwtAuthGuard sigue exigiendo sesión y
 * RolesGuard deja pasar a cualquier autenticado cuando no hay decorador.
 * Las mutaciones sí van con @Roles(...PURCHASE_TEAM).
 */
@Controller('compras/contratos')
export class ContractsController {
  constructor(private readonly service: ContractsService) {}

  // Lectura — cualquier usuario autenticado (sin @Roles, ver nota de clase)
  @Get()
  findAll(@Query() query: ContractQueryDto) {
    return this.service.findAll(query);
  }

  // Antes de ':id' para no colisionar con el ParseUUIDPipe
  @Roles(...PURCHASE_TEAM)
  @Get('alertas/vencimiento')
  findExpiring() {
    return this.service.findExpiring();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Get(':id/documents/:docId/download')
  download(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ) {
    return this.service.getDocumentDownloadUrl(id, docId);
  }

  // Mutaciones — solo equipo de procura
  @Roles(...PURCHASE_TEAM)
  @Post()
  create(@Body() dto: CreateContractDto, @CurrentUser() user: { id: string }) {
    return this.service.create(dto, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContractDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.update(id, dto, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.remove(id, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Post(':id/documents')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }),
  )
  uploadDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.uploadDocument(id, file, user.id);
  }

  @Roles(...PURCHASE_TEAM)
  @Delete(':id/documents/:docId')
  removeDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.removeDocument(id, docId, user.id);
  }
}
