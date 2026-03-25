import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BaseCrudService } from '../common/services/base-crud.service';
import { CreateCourseTypeDto } from './dto/create-course-type.dto';
import { UpdateCourseTypeDto } from './dto/update-course-type.dto';

@Injectable()
export class CourseTypesService extends BaseCrudService<CreateCourseTypeDto, UpdateCourseTypeDto> {
  protected readonly tableName = 'course_types';
  protected readonly selectFields = '*';
  protected readonly orderField = 'name';
  protected readonly searchFields = ['name', 'key'];

  constructor(supabase: SupabaseService) {
    super(supabase);
  }
}
