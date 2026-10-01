import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { OUTBOX_STATUSES } from '../email-outbox.service';

/** J1 — Filtros de la bitácora de correo. */
export class EmailOutboxQueryDto {
  @IsIn(OUTBOX_STATUSES)
  @IsOptional()
  status?: (typeof OUTBOX_STATUSES)[number];

  @IsString()
  @IsOptional()
  @MaxLength(60)
  template?: string;

  /** Destinatario o asunto. */
  @IsString()
  @IsOptional()
  @MaxLength(200)
  search?: string;

  /** Día (YYYY-MM-DD, CDMX) desde el que se encoló. */
  @IsISO8601()
  @IsOptional()
  desde?: string;

  @IsISO8601()
  @IsOptional()
  hasta?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** J1 — Interruptor "Pausar envíos". */
export class EmailPauseDto {
  @IsBoolean()
  paused: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  motivo?: string;
}
