import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PersonnelService } from './personnel.service';
import { CreatePersonnelDto } from './dto/create-personnel.dto';
import { UpdatePersonnelDto } from './dto/update-personnel.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';

@Controller('personnel')
export class PersonnelController {
  constructor(
    private readonly service: PersonnelService,
    private readonly audit: AuditService,
  ) {}

  /**
   * List all collaborators with optional filters
   */
  @Roles('admin_rh')
  @Get()
  findAll(
    @Query('department_id') departmentId?: string,
    @Query('is_active') isActive?: string,
    @Query('search') search?: string,
  ) {
    return this.service.findAll({
      department_id: departmentId,
      is_active: isActive !== undefined ? isActive === 'true' : undefined,
      search,
    });
  }

  /**
   * Get personnel statistics
   */
  @Roles('admin_rh')
  @Get('stats')
  getStats() {
    return this.service.getStats();
  }

  /**
   * Get a single collaborator
   */
  @Roles('admin_rh')
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  /**
   * Create a new collaborator
   */
  @Roles('admin_rh')
  @Post()
  async create(@Body() dto: CreatePersonnelDto, @CurrentUser() user: AuthUser) {
    const result = await this.service.create(dto);
    await this.audit.log({
      action: 'create',
      entity_type: 'user',
      entity_id: result.id,
      entity_name: result.full_name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: {
        email: dto.email,
        full_name: dto.full_name,
        position: dto.position,
        department_id: dto.department_id,
      },
    });
    return result;
  }

  /**
   * Update collaborator data
   */
  @Roles('admin_rh')
  @Put(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePersonnelDto,
    @CurrentUser() user: AuthUser,
  ) {
    const oldData = await this.service.findOne(id);
    const result = await this.service.update(id, dto);
    await this.audit.log({
      action: 'update',
      entity_type: 'user',
      entity_id: id,
      entity_name: result.full_name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      old_values: {
        full_name: oldData.full_name,
        position: oldData.position,
        department_id: oldData.department_id,
      },
      new_values: dto,
    });
    return result;
  }

  /**
   * Deactivate (soft delete) a collaborator
   */
  @Roles('admin_rh')
  @Put(':id/deactivate')
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.service.deactivate(id);
    await this.audit.log({
      action: 'delete',
      entity_type: 'user',
      entity_id: id,
      entity_name: result.full_name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      description: 'Baja lógica de colaborador',
    });
    return result;
  }

  /**
   * Reactivate a collaborator
   */
  @Roles('admin_rh')
  @Put(':id/reactivate')
  async reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.service.reactivate(id);
    await this.audit.log({
      action: 'update',
      entity_type: 'user',
      entity_id: id,
      entity_name: result.full_name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      description: 'Reactivación de colaborador',
    });
    return result;
  }
}
