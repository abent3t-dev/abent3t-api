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

@Controller('requests')
export class RequestsController {
  constructor(private readonly service: RequestsService) {}

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
   * List my requests (jefe_area sees their own requests)
   */
  @Roles('jefe_area', 'director')
  @Get('my-requests')
  findMyRequests(@CurrentUser('id') userId: string) {
    return this.service.findByRequester(userId);
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
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRequestDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.review(id, dto, userId);
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
