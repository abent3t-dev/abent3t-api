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
  ParseIntPipe,
  DefaultValuePipe,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProposalsService } from './proposals.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { ReviewProposalDto } from './dto/review-proposal.dto';
import { ApproveProposalDto } from './dto/approve-proposal.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';

@Controller('proposals')
export class ProposalsController {
  constructor(
    private readonly service: ProposalsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * List all proposals (admin_rh only)
   * Optional filter by status: ?status=pendiente|en_investigacion|aprobada|rechazada
   * Pagination: ?page=1&limit=10
   */
  @Roles('admin_rh')
  @Get()
  findAll(
    @Query('status') status?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit?: number,
  ) {
    return this.service.findAll(status, page, limit);
  }

  /**
   * List pending proposals (admin_rh dashboard)
   */
  @Roles('admin_rh')
  @Get('pending')
  findPending() {
    return this.service.findPending();
  }

  /**
   * Get my proposals (as proposer or beneficiary)
   */
  @Get('my-proposals')
  findMyProposals(@CurrentUser('id') userId: string) {
    return this.service.findByUser(userId);
  }

  /**
   * Get proposals of my team (jefe_area / director)
   * Returns proposals where the proposer or beneficiary is in the user's department
   */
  @Roles('jefe_area', 'director')
  @Get('my-team')
  findMyTeam(@CurrentUser() user: AuthUser) {
    if (!user.department_id) return [];
    return this.service.findByDepartment(user.department_id);
  }

  /**
   * Get a single proposal
   */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  /**
   * Create a new course proposal
   * Any authenticated user can propose a course
   */
  @Post()
  async create(
    @Body() dto: CreateProposalDto,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.service.create(
      dto,
      user.id,
      user.role,
      user.department_id,
    );

    await this.audit.log({
      action: 'create',
      entity_type: 'proposal',
      entity_id: result.id,
      entity_name: dto.course_name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: {
        course_name: dto.course_name,
        institution_name: dto.institution_name,
        estimated_cost: dto.estimated_cost,
      },
    });

    return result;
  }

  /**
   * Review a proposal (change status to en_investigacion or rechazada)
   */
  @Roles('admin_rh')
  @Put(':id/review')
  async review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewProposalDto,
    @CurrentUser() user: AuthUser,
  ) {
    const proposal = await this.service.findOne(id);
    const result = await this.service.review(id, dto, user.id);

    await this.audit.log({
      action: dto.status === 'rechazada' ? 'reject' : 'update',
      entity_type: 'proposal',
      entity_id: id,
      entity_name: proposal.course_name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      old_values: { status: proposal.status },
      new_values: {
        status: dto.status,
        rejection_reason: dto.rejection_reason,
      },
    });

    return result;
  }

  /**
   * Approve a proposal by creating the course, edition, and enrollment
   */
  @Roles('admin_rh')
  @Put(':id/approve')
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveProposalDto,
    @CurrentUser() user: AuthUser,
  ) {
    const proposal = await this.service.findOne(id);
    const result = await this.service.approve(id, dto, user.id);

    await this.audit.log({
      action: 'approve',
      entity_type: 'proposal',
      entity_id: id,
      entity_name: proposal.course_name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: {
        status: 'aprobada',
        course_id: result.course.id,
        course_name: dto.course_name,
        cost: dto.cost,
      },
      description: `Propuesta aprobada. Curso creado: ${dto.course_name}`,
    });

    return result;
  }

  /**
   * Cancel a proposal (by the proposer)
   */
  @Delete(':id')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const proposal = await this.service.findOne(id);
    const result = await this.service.cancel(id, user.id);

    await this.audit.log({
      action: 'delete',
      entity_type: 'proposal',
      entity_id: id,
      entity_name: proposal.course_name,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
    });

    return result;
  }

  // =====================================================
  // ATTACHMENTS
  // =====================================================

  /**
   * Lista archivos adjuntos de una propuesta
   */
  @Get(':id/attachments')
  listAttachments(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.listAttachments(id);
  }

  /**
   * Sube un archivo adjunto a la propuesta (solo proponente o admin_rh)
   */
  @Post(':id/attachments')
  @UseInterceptors(FileInterceptor('file'))
  uploadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.uploadAttachment(id, file, user.id, user.role);
  }

  /**
   * Genera URL firmada de descarga para un archivo adjunto
   */
  @Get('attachments/:attachmentId/download')
  downloadAttachment(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    return this.service.getAttachmentDownloadUrl(attachmentId);
  }

  /**
   * Elimina (soft delete) un archivo adjunto
   */
  @Delete('attachments/:attachmentId')
  removeAttachment(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.removeAttachment(attachmentId, user.id, user.role);
  }
}
