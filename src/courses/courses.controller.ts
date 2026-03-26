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
} from '@nestjs/common';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';

@Controller('courses')
export class CoursesController {
  constructor(
    private readonly service: CoursesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  findAll(@Query() pagination: PaginationDto) {
    if (pagination.page || pagination.limit || pagination.search) {
      return this.service.findAllPaginated(pagination);
    }
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Roles('admin_rh')
  @Post()
  async create(@Body() dto: CreateCourseDto, @CurrentUser() user: AuthUser) {
    const result = await this.service.create(dto);
    await this.audit.log({
      action: 'create',
      entity_type: 'course',
      entity_id: result.id,
      entity_name: result.name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: dto,
    });
    return result;
  }

  @Roles('admin_rh')
  @Put(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourseDto,
    @CurrentUser() user: AuthUser,
  ) {
    const oldCourse = await this.service.findOne(id);
    const result = await this.service.update(id, dto);
    await this.audit.log({
      action: 'update',
      entity_type: 'course',
      entity_id: id,
      entity_name: result.name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      old_values: { name: oldCourse.name, cost: oldCourse.cost, total_hours: oldCourse.total_hours },
      new_values: dto,
    });
    return result;
  }

  @Roles('admin_rh')
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const course = await this.service.findOne(id);
    const result = await this.service.remove(id);
    await this.audit.log({
      action: 'delete',
      entity_type: 'course',
      entity_id: id,
      entity_name: course.name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
    });
    return result;
  }
}
