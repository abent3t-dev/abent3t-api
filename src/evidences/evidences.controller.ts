import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EvidencesService } from './evidences.service';
import { CreateEvidenceDto } from './dto/create-evidence.dto';
import { UpdateEvidenceDto } from './dto/update-evidence.dto';
import { VerifyEvidenceDto } from './dto/verify-evidence.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';

@Controller('evidences')
export class EvidencesController {
  constructor(
    private readonly service: EvidencesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lista todas las evidencias (admin_rh)
   * Soporta paginación mediante query params: ?page=1&limit=10
   * Soporta filtro por status: ?status=pending|approved|rejected
   */
  @Roles('admin_rh')
  @Get()
  findAll(@Query() pagination: PaginationDto, @Query('status') status?: string) {
    // Si se solicita paginación
    if (pagination.page || pagination.limit) {
      // Si se filtra por status específico
      if (status === 'pending') {
        return this.service.findPendingPaginated(pagination);
      }
      if (status === 'approved' || status === 'rejected') {
        return this.service.findByStatusPaginated(status, pagination);
      }
      // Todas las evidencias con paginación
      return this.service.findAllPaginated(pagination);
    }
    // Sin paginación (comportamiento legacy)
    return this.service.findAll();
  }

  /**
   * Lista evidencias pendientes de verificación (admin_rh)
   * Endpoint legacy mantenido para compatibilidad
   */
  @Roles('admin_rh')
  @Get('pending')
  findPending() {
    return this.service.findPending();
  }

  /**
   * Lista evidencias de una inscripción específica
   */
  @Get('enrollment/:enrollmentId')
  findByEnrollment(@Param('enrollmentId', ParseUUIDPipe) enrollmentId: string) {
    return this.service.findByEnrollment(enrollmentId);
  }

  /**
   * Obtiene una evidencia por ID
   */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  /**
   * Obtiene URL de descarga de archivo
   */
  @Get(':id/download')
  getDownloadUrl(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getDownloadUrl(id);
  }

  /**
   * Sube una nueva evidencia
   * - admin_rh puede subir para cualquier inscripción
   * - colaborador puede subir solo para sus inscripciones (validado en service)
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: CreateEvidenceDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.upload(file, dto, userId);
  }

  /**
   * Actualiza una evidencia
   */
  @Roles('admin_rh')
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEvidenceDto,
  ) {
    return this.service.update(id, dto);
  }

  /**
   * Verifica (aprueba/rechaza) una evidencia
   */
  @Roles('admin_rh')
  @Put(':id/verify')
  async verify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyEvidenceDto,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.service.verify(id, dto, user.id);
    await this.audit.log({
      action: dto.verification_status === 'approved' ? 'approve' : 'reject',
      entity_type: 'evidence',
      entity_id: id,
      entity_name: result.file_name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: {
        status: dto.verification_status,
        rejection_reason: dto.rejection_reason,
      },
    });
    return result;
  }

  /**
   * Elimina una evidencia (soft delete)
   */
  @Roles('admin_rh')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
