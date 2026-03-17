import { Module } from '@nestjs/common';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { CourseEditionsController } from './course-editions.controller';
import { CourseEditionsService } from './course-editions.service';

@Module({
  controllers: [CoursesController, CourseEditionsController],
  providers: [CoursesService, CourseEditionsService],
  exports: [CoursesService, CourseEditionsService],
})
export class CoursesModule {}
