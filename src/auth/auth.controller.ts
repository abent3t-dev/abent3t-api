import {
  Controller,
  Get,
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

  /** List all users (Admin RH only) */
  @Get('users')
  @UseGuards(RolesGuard)
  @Roles('admin_rh')
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

  /** Assign role to user (Admin RH only) */
  @Put('users/:id/role')
  @UseGuards(RolesGuard)
  @Roles('admin_rh')
  updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('role') role: string,
  ) {
    return this.service.updateRole(id, role);
  }

  /** Assign department to user (Admin RH only) */
  @Put('users/:id/department')
  @UseGuards(RolesGuard)
  @Roles('admin_rh')
  assignDepartment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('department_id') departmentId: string,
  ) {
    return this.service.assignDepartment(id, departmentId);
  }

  /** Deactivate user - soft delete (Admin RH only) */
  @Put('users/:id/deactivate')
  @UseGuards(RolesGuard)
  @Roles('admin_rh')
  deactivateUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deactivateUser(id);
  }
}
