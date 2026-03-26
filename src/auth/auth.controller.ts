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

  /** List all users (Super Admin only) */
  @Get('users')
  @UseGuards(RolesGuard)
  @Roles('super_admin')
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
  ) {
    return this.service.updateRole(id, role);
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
  ) {
    return this.service.createUser(body);
  }
}
