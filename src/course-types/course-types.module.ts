import { Module } from '@nestjs/common';
import { CourseTypesController } from './course-types.controller';
import { CourseTypesService } from './course-types.service';

@Module({
  controllers: [CourseTypesController],
  providers: [CourseTypesService],
  exports: [CourseTypesService],
})
export class CourseTypesModule {}
