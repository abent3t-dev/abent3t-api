import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateRequisitionDto } from './create-requisition.dto';

export class UpdateRequisitionDto extends PartialType(
  OmitType(CreateRequisitionDto, ['rq_number', 'requester_id', 'source', 'external_id', 'created_date'] as const),
) {}
