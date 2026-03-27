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
import { RequestsService } from './requests.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { ReviewRequestDto } from './dto/review-request.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';

@Controller('requests')
export class RequestsController {
  constructor(
    private readonly service: RequestsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * List all requests (admin_rh only)
   * Optional filter by status: ?status=pendiente|aprobada|rechazada
   */
  @Roles('admin_rh')
  @Get()
  findAll(@Query('status') status?: string) {
    return this.service.findAll(status);
  }

  /**
   * List pending requests (admin_rh only)
   */
  @Roles('admin_rh')
  @Get('pending')
  findPending() {
    return this.service.findPending();
  }

  /**
   * List my requests:
   * - jefe_area/director: sees requests they created
   * - colaborador: sees requests where they are the beneficiary
   */
  @Get('my-requests')
  findMyRequests(@CurrentUser() user: AuthUser) {
    if (['jefe_area', 'director'].includes(user.role)) {
      return this.service.findByRequester(user.id);
    }
    // colaborador sees requests where they are the beneficiary
    return this.service.findByBeneficiary(user.id);
  }

  /**
   * Get request by ID
   */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  /**
   * Create a new request (jefe_area only)
   */
  @Roles('jefe_area', 'director')
  @Post()
  create(
    @Body() dto: CreateRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.create(dto, user.id, user.department_id);
  }

  /**
   * Review (approve/reject) a request (admin_rh only)
   */
  @Roles('admin_rh')
  @Put(':id/review')
  async review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.service.review(id, dto, user.id);
    const profile = result.profiles as any;
    const course = (result.course_editions as any)?.courses;
    await this.audit.log({
      action: dto.status === 'aprobada' ? 'approve' : 'reject',
      entity_type: 'request',
      entity_id: id,
      entity_name: `${profile?.full_name || 'Colaborador'} - ${course?.name || 'Curso'}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: {
        status: dto.status,
        rejection_reason: dto.rejection_reason,
      },
    });
    return result;
  }

  /**
   * Cancel a request (only the requester, only if pending)
   */
  @Roles('jefe_area', 'director')
  @Delete(':id')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.cancel(id, userId);
  }
}
