import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCrudPrismaService } from '../common/services/base-crud-prisma.service';
import { CreateCourseTypeDto } from './dto/create-course-type.dto';
import { UpdateCourseTypeDto } from './dto/update-course-type.dto';

@Injectable()
export class CourseTypesService extends BaseCrudPrismaService<
  CreateCourseTypeDto,
  UpdateCourseTypeDto
> {
  protected get model() {
    return this.prisma.course_types;
  }
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name', 'key'];

  constructor(prisma: PrismaService) {
    super(prisma);
  }
}
