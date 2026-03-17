import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  ParseUUIDPipe,
} from '@nestjs/common';
import { CourseEditionsService } from './course-editions.service';
import { CreateCourseEditionDto } from './dto/create-course-edition.dto';
import { UpdateCourseEditionDto } from './dto/update-course-edition.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('courses/:courseId/editions')
export class CourseEditionsController {
  constructor(private readonly service: CourseEditionsService) {}

  @Get()
  findAll(@Param('courseId', ParseUUIDPipe) courseId: string) {
    return this.service.findByCourse(courseId);
  }

  @Get(':id')
  findOne(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(courseId, id);
  }

  @Roles('admin_rh')
  @Post()
  create(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() dto: CreateCourseEditionDto,
  ) {
    return this.service.create(courseId, dto);
  }

  @Roles('admin_rh')
  @Put(':id')
  update(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourseEditionDto,
  ) {
    return this.service.update(courseId, id, dto);
  }

  @Roles('admin_rh')
  @Delete(':id')
  remove(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(courseId, id);
  }
}
