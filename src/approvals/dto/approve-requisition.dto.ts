import { IsString, IsUUID, IsOptional, IsNotEmpty } from 'class-validator';

export class ApproveRequisitionDto {
  @IsUUID()
  @IsNotEmpty()
  requisition_id: string;

  @IsString()
  @IsOptional()
  comments?: string;
}

export class RejectRequisitionDto {
  @IsUUID()
  @IsNotEmpty()
  requisition_id: string;

  @IsString()
  @IsNotEmpty()
  rejection_reason: string;
}
