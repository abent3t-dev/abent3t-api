import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PlatformsService } from './platforms.service';
import { CreateIntegrationDto } from './dto/create-integration.dto';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { SyncOptionsDto } from './dto/sync-options.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('platforms')
export class PlatformsController {
  constructor(private readonly platformsService: PlatformsService) {}

  // =====================================================
  // CREHANA — VISTAS PARA EL FRONTEND
  // =====================================================
  // IMPORTANTE: estos endpoints van ANTES de las rutas con `:id` para que
  // NestJS no intente parsear "crehana" como UUID en `@Get(':id/courses')`,
  // `@Get('courses/:courseId')`, etc.

  @Get('crehana/dashboard')
  @Roles('super_admin', 'admin_rh', 'executive')
  getCrehanaDashboard() {
    return this.platformsService.getCrehanaDashboard();
  }

  @Get('crehana/courses')
  @Roles('super_admin', 'admin_rh', 'executive')
  findCrehanaCourses() {
    return this.platformsService.findCrehanaCourses();
  }

  @Get('crehana/courses/:externalCourseId')
  @Roles('super_admin', 'admin_rh', 'executive')
  findCrehanaCourseDetail(@Param('externalCourseId') externalCourseId: string) {
    return this.platformsService.findCrehanaCourseDetail(externalCourseId);
  }

  @Get('crehana/users')
  @Roles('super_admin', 'admin_rh', 'executive')
  findCrehanaUsers() {
    return this.platformsService.findCrehanaUsers();
  }

  @Get('crehana/users/:externalUserId')
  @Roles('super_admin', 'admin_rh', 'executive')
  findCrehanaUserDetail(@Param('externalUserId') externalUserId: string) {
    return this.platformsService.findCrehanaUserDetail(externalUserId);
  }

  // =====================================================
  // INTEGRACIONES
  // =====================================================

  /**
   * Listar todas las integraciones de plataformas
   * Solo admin_rh y super_admin
   */
  @Get()
  @Roles('super_admin', 'admin_rh')
  findAllIntegrations() {
    return this.platformsService.findAllIntegrations();
  }

  /**
   * Obtener detalle de una integración
   */
  @Get(':id')
  @Roles('super_admin', 'admin_rh')
  findIntegrationById(@Param('id', ParseUUIDPipe) id: string) {
    return this.platformsService.findIntegrationById(id);
  }

  /**
   * Obtener integración por institución
   */
  @Get('institution/:institutionId')
  @Roles('super_admin', 'admin_rh')
  findIntegrationByInstitution(
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
  ) {
    return this.platformsService.findIntegrationByInstitution(institutionId);
  }

  /**
   * Crear nueva integración de plataforma
   */
  @Post()
  @Roles('super_admin', 'admin_rh')
  createIntegration(
    @Body() dto: CreateIntegrationDto,
    @CurrentUser() user: any,
  ) {
    return this.platformsService.createIntegration(dto, user.id);
  }

  /**
   * Actualizar integración
   */
  @Put(':id')
  @Roles('super_admin', 'admin_rh')
  updateIntegration(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIntegrationDto,
  ) {
    return this.platformsService.updateIntegration(id, dto);
  }

  /**
   * Desactivar integración
   */
  @Delete(':id')
  @Roles('super_admin', 'admin_rh')
  removeIntegration(@Param('id', ParseUUIDPipe) id: string) {
    return this.platformsService.removeIntegration(id);
  }

  /**
   * Probar conexión con la plataforma
   */
  @Post(':id/test-connection')
  @Roles('super_admin', 'admin_rh')
  testConnection(@Param('id', ParseUUIDPipe) id: string) {
    return this.platformsService.testConnection(id);
  }

  // =====================================================
  // SINCRONIZACIÓN
  // =====================================================

  /**
   * Disparar sincronización manual
   */
  @Post(':id/sync')
  @Roles('super_admin', 'admin_rh')
  triggerSync(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() options: SyncOptionsDto,
    @CurrentUser() user: any,
  ) {
    return this.platformsService.triggerSync(id, options, user.id);
  }

  /**
   * Obtener historial de sincronizaciones
   */
  @Get(':id/sync-logs')
  @Roles('super_admin', 'admin_rh')
  findSyncLogs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.platformsService.findSyncLogs(id, limit ? parseInt(limit) : 20);
  }

  // =====================================================
  // CURSOS DE PLATAFORMA
  // =====================================================

  /**
   * Listar todos los cursos de plataformas
   */
  @Get('courses/all')
  @Roles('super_admin', 'admin_rh')
  findAllPlatformCourses() {
    return this.platformsService.findAllPlatformCourses();
  }

  /**
   * Listar cursos de una integración específica
   */
  @Get(':id/courses')
  @Roles('super_admin', 'admin_rh')
  findCoursesByIntegration(@Param('id', ParseUUIDPipe) id: string) {
    return this.platformsService.findCoursesByIntegration(id);
  }

  /**
   * Obtener detalle de un curso de plataforma
   */
  @Get('courses/:courseId')
  @Roles('super_admin', 'admin_rh', 'jefe_area', 'director', 'colaborador', 'collaborator')
  findPlatformCourseById(@Param('courseId', ParseUUIDPipe) courseId: string) {
    return this.platformsService.findPlatformCourseById(courseId);
  }

  // =====================================================
  // INSCRIPCIONES/PROGRESO
  // =====================================================

  /**
   * Obtener resumen general de progreso en plataformas
   */
  @Get('enrollments/summary')
  @Roles('super_admin', 'admin_rh', 'executive')
  getEnrollmentsSummary() {
    return this.platformsService.getEnrollmentsSummary();
  }

  /**
   * Obtener progreso de un colaborador en plataformas
   */
  @Get('enrollments/profile/:profileId')
  @Roles('super_admin', 'admin_rh', 'jefe_area', 'director', 'colaborador', 'collaborator')
  findEnrollmentsByProfile(@Param('profileId', ParseUUIDPipe) profileId: string) {
    return this.platformsService.findEnrollmentsByProfile(profileId);
  }

  /**
   * Obtener progreso de un departamento en plataformas
   */
  @Get('enrollments/department/:departmentId')
  @Roles('super_admin', 'admin_rh', 'jefe_area', 'director')
  findEnrollmentsByDepartment(
    @Param('departmentId', ParseUUIDPipe) departmentId: string,
  ) {
    return this.platformsService.findEnrollmentsByDepartment(departmentId);
  }
}
