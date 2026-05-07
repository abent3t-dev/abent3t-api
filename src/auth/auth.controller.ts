import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  /** Get current user's profile */
  @Get('me')
  getMe(@CurrentUser() user: AuthUser) {
    return this.service.getProfile(user.id);
  }

  /** Get team members (jefe_area/director - returns users from their department) */
  @Get('my-team')
  @Roles('jefe_area', 'director', 'admin_rh', 'super_admin')
  getMyTeam(@CurrentUser() user: AuthUser) {
    if (!user.department_id) {
      return [];
    }
    return this.service.getMyTeam(user.department_id, user.id);
  }

  /**
   * Buscar usuario por email (super_admin y admin_rh).
   * Usado por la UI de alta para detectar emails ya registrados antes del submit.
   */
  @Get('lookup-email')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin_rh')
  lookupEmail(@Query('email') email: string) {
    return this.service.lookupByEmail(email || '');
  }

  /** List all users (Super Admin and admin_rh) */
  @Get('users')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin_rh')
  listUsers(
    @Query('role') role?: string,
    @Query('department_id') departmentId?: string,
    @Query('is_active') isActive?: string,
  ) {
    return this.service.listUsers({
      role,
      department_id: departmentId,
      is_active: isActive !== undefined ? isActive === 'true' : undefined,
    });
  }

  /** Assign role to user (Super Admin only) */
  @Put('users/:id/role')
  @UseGuards(RolesGuard)
  @Roles('super_admin')
  updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('role') role: string,
    @CurrentUser() current: AuthUser,
  ) {
    return this.service.updateRole(id, role, current.id);
  }

  /** Assign department to user (Super Admin only) */
  @Put('users/:id/department')
  @UseGuards(RolesGuard)
  @Roles('super_admin')
  assignDepartment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('department_id') departmentId: string,
  ) {
    return this.service.assignDepartment(id, departmentId);
  }

  /** Deactivate user - soft delete (Super Admin only) */
  @Put('users/:id/deactivate')
  @UseGuards(RolesGuard)
  @Roles('super_admin')
  deactivateUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deactivateUser(id);
  }

  /** Reactivate user (Super Admin only) */
  @Put('users/:id/reactivate')
  @UseGuards(RolesGuard)
  @Roles('super_admin')
  reactivateUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.reactivateUser(id);
  }

  /** Create new user (Super Admin only) */
  @Post('users')
  @UseGuards(RolesGuard)
  @Roles('super_admin')
  createUser(
    @Body() body: {
      email: string;
      password: string;
      full_name: string;
      position?: string;
      role?: string;
      department_id?: string;
    },
    @CurrentUser() current: AuthUser,
  ) {
    return this.service.createUser(body, current.id);
  }

  // =====================================================
  // GESTIÓN DE ROLES POR MÓDULO
  // =====================================================

  /**
   * Listar asignaciones de rol por módulo de un usuario.
   * super_admin ve todas; admin_rh también ve todas (de solo lectura) para
   * que pueda gestionar las de capacitación con contexto.
   */
  @Get('users/:id/roles')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin_rh')
  listUserRoles(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.listUserRoles(id);
  }

  /**
   * Asignar un rol a un usuario en un módulo.
   * super_admin puede asignar cualquier rol en cualquier módulo.
   * admin_rh solo puede asignar Colaborador o Jefe de Área en Capacitación.
   */
  @Post('users/:id/roles')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin_rh')
  assignUserRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { module: string; role: string },
    @CurrentUser() current: AuthUser,
  ) {
    const isSuper = current.roles?.includes('super_admin');
    const allowedModules = isSuper ? undefined : ['capacitacion'];
    const allowedRoles = isSuper ? undefined : ['colaborador', 'jefe_area'];
    return this.service.assignUserRole(
      id,
      body.module,
      body.role,
      current.id,
      allowedModules,
      allowedRoles,
    );
  }

  /**
   * Revocar una asignación de rol.
   * super_admin puede revocar cualquier rol.
   * admin_rh solo puede revocar Colaborador o Jefe de Área en Capacitación.
   */
  @Put('users/:id/roles/:roleId/revoke')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin_rh')
  revokeUserRole(
    @Param('id', ParseUUIDPipe) _id: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @CurrentUser() current: AuthUser,
  ) {
    const isSuper = current.roles?.includes('super_admin');
    const allowedModules = isSuper ? undefined : ['capacitacion'];
    const allowedRoles = isSuper ? undefined : ['colaborador', 'jefe_area'];
    return this.service.revokeUserRole(roleId, current.id, allowedModules, allowedRoles);
  }
}
