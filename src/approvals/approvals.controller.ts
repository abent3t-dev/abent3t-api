import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { ApproveRequisitionDto, RejectRequisitionDto } from './dto/approve-requisition.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// Roles de aprobadores
const APPROVERS = ['aprobador_nivel_1', 'aprobador_nivel_2', 'aprobador_nivel_3', 'director_general'];
const PURCHASE_TEAM = ['lider_procura', 'coordinador_compras', 'comprador'];
const ALL_PURCHASE_ROLES = [...PURCHASE_TEAM, ...APPROVERS];

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly service: ApprovalsService) {}

  @Roles(...APPROVERS)
  @Get('pending')
  getPending(@CurrentUser() user: { id: string; role: string }) {
    return this.service.getPending(user.id, user.role);
  }

  @Roles(...APPROVERS)
  @Get('my-approvals')
  getMyApprovals(
    @CurrentUser() user: { id: string },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getMyApprovals(
      user.id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Roles(...ALL_PURCHASE_ROLES)
  @Get('requisition/:rqId')
  getWorkflowByRequisition(@Param('rqId', ParseUUIDPipe) rqId: string) {
    return this.service.getWorkflowByRequisition(rqId);
  }

  @Roles(...ALL_PURCHASE_ROLES)
  @Get('stats')
  getStats() {
    return this.service.getStats();
  }

  @Roles(...PURCHASE_TEAM)
  @Post('start-workflow/:rqId')
  startWorkflow(
    @Param('rqId', ParseUUIDPipe) rqId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.startWorkflow(rqId, user.id);
  }

  @Roles(...APPROVERS)
  @Post('approve')
  approve(
    @Body() dto: ApproveRequisitionDto,
    @CurrentUser() user: { id: string; role: string },
  ) {
    return this.service.approve(dto.requisition_id, user.id, user.role, dto.comments);
  }

  @Roles(...APPROVERS)
  @Post('reject')
  reject(
    @Body() dto: RejectRequisitionDto,
    @CurrentUser() user: { id: string; role: string },
  ) {
    return this.service.reject(dto.requisition_id, user.id, user.role, dto.rejection_reason);
  }
}
