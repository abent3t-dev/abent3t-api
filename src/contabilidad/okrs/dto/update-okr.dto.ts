import { PartialType } from '@nestjs/mapped-types';
import { CreateOkrDto } from './create-okr.dto';
import { IsEnum, IsOptional } from 'class-validator';

// Enum matching DB: okr_status ('on_track', 'at_risk', 'behind', 'completed')
export enum OkrStatus {
  ON_TRACK = 'on_track',
  AT_RISK = 'at_risk',
  BEHIND = 'behind',
  COMPLETED = 'completed',
}

export class UpdateOkrDto extends PartialType(CreateOkrDto) {
  @IsEnum(OkrStatus)
  @IsOptional()
  status?: OkrStatus;
}
