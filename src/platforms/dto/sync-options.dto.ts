import { IsEnum, IsOptional, IsBoolean } from 'class-validator';

export enum SyncType {
  FULL = 'full',
  INCREMENTAL = 'incremental',
  USERS = 'users',
  COURSES = 'courses',
  PROGRESS = 'progress',
}

export class SyncOptionsDto {
  @IsOptional()
  @IsEnum(SyncType)
  sync_type?: SyncType;

  @IsOptional()
  @IsBoolean()
  force?: boolean; // Forzar sincronización aunque no haya pasado el intervalo
}
