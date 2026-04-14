import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  ParseUUIDPipe,
  ForbiddenException,
} from '@nestjs/common';
import { EnrollmentsService, EnrichedEnrollment } from './enrollments.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { BulkEnrollmentDto } from './dto/bulk-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';

@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly service: EnrollmentsService) {}

  @Roles('admin_rh')
  @Get()
  findAll(): Promise<EnrichedEnrollment[]> {
    return this.service.findAll();
  }

  @Get('edition/:editionId')
  findByEdition(@Param('editionId', ParseUUIDPipe) editionId: string): Promise<EnrichedEnrollment[]> {
    return this.service.findByEdition(editionId);
  }

  /**
   * Obtiene inscripciones de un perfil
   * - admin_rh puede ver cualquier perfil
   * - Otros usuarios solo pueden ver su propio perfil
   */
  @Get('profile/:profileId')
  findByProfile(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @CurrentUser('id') currentUserId: string,
    @CurrentUser('role') role: string,
  ): Promise<EnrichedEnrollment[]> {
    // Permitir si es admin_rh o si solicita sus propios datos
    if (role !== 'admin_rh' && profileId !== currentUserId) {
      throw new ForbiddenException('Solo puedes ver tus propias inscripciones');
    }
    return this.service.findByProfile(profileId);
  }

  /**
   * Obtiene inscripciones de un departamento
   * - admin_rh puede ver cualquier departamento
   * - jefe_area/director solo pueden ver su propio departamento
   */
  @Get('department/:departmentId')
  findByDepartment(
    @Param('departmentId', ParseUUIDPipe) departmentId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<EnrichedEnrollment[]> {
    // Permitir si es admin_rh o super_admin
    if (user.role === 'admin_rh' || user.role === 'super_admin') {
      return this.service.findByDepartment(departmentId);
    }
    // jefe_area/director solo pueden ver su departamento
    if ((user.role === 'jefe_area' || user.role === 'director') && user.department_id === departmentId) {
      return this.service.findByDepartment(departmentId);
    }
    throw new ForbiddenException('Solo puedes ver inscripciones de tu departamento');
  }

  @Roles('admin_rh')
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<EnrichedEnrollment> {
    return this.service.findOne(id);
  }

  @Roles('admin_rh')
  @Post()
  create(@Body() dto: CreateEnrollmentDto) {
    return this.service.create(dto);
  }

  @Roles('admin_rh')
  @Post('bulk')
  createBulk(@Body() dto: BulkEnrollmentDto) {
    return this.service.createBulk(dto);
  }

  @Roles('admin_rh')
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEnrollmentDto,
  ) {
    return this.service.update(id, dto);
  }

  @Roles('admin_rh')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }

  /**
   * Colaborador marca su curso como finalizado
   * Cambia estado a 'pendiente_evidencia' para que pueda subir evidencias
   */
  @Put(':id/finish')
  async finishCourse(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    // Verificar que la inscripción pertenece al usuario
    const enrollment = await this.service.findOne(id);
    if (enrollment.profile_id !== user.id && user.role !== 'admin_rh' && user.role !== 'super_admin') {
      throw new ForbiddenException('Solo puedes finalizar tus propios cursos');
    }
    return this.service.finishCourse(id);
  }

  /**
   * Obtiene el estado efectivo de una inscripción basado en fechas
   */
  @Get(':id/effective-status')
  async getEffectiveStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const enrollment = await this.service.findOne(id);
    if (enrollment.profile_id !== user.id && user.role !== 'admin_rh' && user.role !== 'super_admin') {
      throw new ForbiddenException('Solo puedes ver tus propias inscripciones');
    }
    return this.service.getEffectiveStatus(enrollment);
  }
}
