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
import { EnrollmentsService } from './enrollments.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { BulkEnrollmentDto } from './dto/bulk-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly service: EnrollmentsService) {}

  @Roles('admin_rh')
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get('edition/:editionId')
  findByEdition(@Param('editionId', ParseUUIDPipe) editionId: string) {
    return this.service.findByEdition(editionId);
  }

  // TODO: agregar lógica para que el propio usuario pueda ver sus enrollments
  @Roles('admin_rh')
  @Get('profile/:profileId')
  findByProfile(@Param('profileId', ParseUUIDPipe) profileId: string) {
    return this.service.findByProfile(profileId);
  }

  @Roles('admin_rh')
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Roles('admin_rh')
  @Post()
  create(@Body() dto: CreateEnrollmentDto) {
    return this.service.create(dto);
  }

  @Roles('admin_rh')
  @Post('bulk')
  createBulk(@Body() dto: BulkEnrollmentDto) {
    return this.service.createBulk(dto);
  }

  @Roles('admin_rh')
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEnrollmentDto,
  ) {
    return this.service.update(id, dto);
  }

  @Roles('admin_rh')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
